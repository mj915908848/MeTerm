export const WATCH_BUFFER_LIMIT = 64 * 1024;
export function watchTimeoutSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(300, Math.max(3, value)) : 60;
}

/** Bounded output and deadline/abort lifecycle; never sends terminal input. */
export function createWatchLifecycle(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  finish: (reason: 'aborted' | 'timeout') => void,
) {
  let buffer = '';
  let truncated = false;
  let disposed = false;
  const onAbort = () => { if (!disposed) finish('aborted'); };
  const timer = setTimeout(() => { if (!disposed) finish('timeout'); }, timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    start() { if (signal?.aborted) onAbort(); },
    append(data: string) {
      if (disposed) return;
      const combined = buffer + data;
      truncated ||= combined.length > WATCH_BUFFER_LIMIT;
      buffer = combined.slice(-WATCH_BUFFER_LIMIT);
    },
    get output() { return buffer; },
    get wasTruncated() { return truncated; },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

// ─── Watch precheck ───────────────────────────────────────────────
//
// watch_terminal used to be purely "wait for a FUTURE event": shell-idle
// (OSC 7768), new output, the idle timeout, or the absolute deadline.
// None of those are replayed. A command that finished BEFORE the watch
// began already emitted its one and only shell-idle signal, so the
// watcher sat there until idle_timeout (default 15s) and then reported
// idle_no_signal with an empty body — even though the whole result had
// been on screen the entire time.
//
// precheckWatch() closes that gap. It inspects state captured at call
// time and lets the caller finish immediately when the terminal is
// demonstrably done. It is deliberately pure so the decision is unit
// testable without a DOM, a PTY, or a real terminal.

export type ShellPhase = 'unknown' | 'ready' | 'agent_executing' | 'user_active';

export type WatchPrecheck =
  | { kind: 'completed'; source: 'shell-hook' | 'prompt-tail' }
  | { kind: 'pattern_matched'; match: string }
  | { kind: 'proceed' };

/** How much of the serialized buffer we keep for prompt/pattern checks. */
export const WATCH_TAIL_CHARS = 4 * 1024;

/** How many screen characters the precheck prompt detector may look at. */
export const WATCH_DETECT_TAIL_CHARS = 1200;

/** Silence (ms) after which an exposed shell prompt counts as "done"
 *  when shell integration is unavailable (SSH host without the hook). */
export const WATCH_PROMPT_SETTLE_MS = 2000;

/** Silence (ms) required before the interactive-state detector runs.
 *  Without this the detector re-scanned the whole buffer every 400ms
 *  and could fire on a partial line. */
export const WATCH_DETECT_SILENCE_MS = 1200;

/**
 * If input reached the terminal within this window, a prompt-shaped
 * tail is still the OLD prompt — the command it was typed for may not
 * have started yet. Treating it as "finished" there would make the
 * watcher return before the command ever ran.
 */
export const WATCH_RECENT_INPUT_GUARD_MS = 2000;

/** Keep the last `limit` characters, trimmed to a line boundary. */
export function tailOf(text: string, limit = WATCH_TAIL_CHARS): string {
  if (text.length <= limit) return text;
  const sliced = text.slice(-limit);
  // Start on a line boundary so the tail never opens with half a line,
  // which would confuse both the pattern check and the prompt detector.
  const nl = sliced.indexOf('\n');
  return nl === -1 ? sliced : sliced.slice(nl + 1);
}

/** Last non-empty line in `tail` matching `pattern`, trimmed; else null. */
export function lastMatchingLine(tail: string, pattern: RegExp): string | null {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Reset lastIndex so a caller-supplied /g or /y pattern cannot
    // resume mid-string and skip a match.
    pattern.lastIndex = 0;
    if (pattern.test(line)) return line.trim();
  }
  return null;
}

/**
 * Decide whether a watch can finish the moment it starts, from state
 * captured BEFORE the watch window opens.
 *
 * Precedence:
 *   1. The caller's own `pattern` — if the line it is waiting for is
 *      already on screen, that is unambiguously the answer.
 *   2. Shell integration (`hookInjected`): phase 'ready' is the
 *      authoritative "prompt is up, no foreground job" signal. When the
 *      hook is present we trust it and nothing else.
 *   3. No hook available: fall back to "the visible tail looks like a
 *      shell prompt", the same last-resort signal run_command uses.
 */
export function precheckWatch(input: {
  hookInjected: boolean;
  phase: ShellPhase;
  tail: string;
  pattern: RegExp | null;
  tailIsPrompt: boolean;
}): WatchPrecheck {
  if (input.pattern) {
    const match = lastMatchingLine(input.tail, input.pattern);
    if (match) return { kind: 'pattern_matched', match };
  }
  if (input.hookInjected) {
    if (input.phase === 'ready') return { kind: 'completed', source: 'shell-hook' };
    return { kind: 'proceed' };
  }
  if (input.tailIsPrompt) return { kind: 'completed', source: 'prompt-tail' };
  return { kind: 'proceed' };
}
