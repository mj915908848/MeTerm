// ─── AI Tools Shell Integration & Command Executor ────────────
// Handles shell hook injection (OSC 7768), command execution via
// shell integration or OSC 7766 markers, output capture & cleanup.

import { TerminalRegistry } from './terminal';
// NOTE: The previous implementation used `invoke('inject_osc_marker')`
// to fake a completion marker after 1.5s of silence.  That hack caused
// false positives for interactive commands (ssh/sudo password prompts,
// vim/top TUIs) — the wait would resolve while the process was still
// blocking the PTY.  We now detect interactive state via prompt
// patterns and alt-screen flags instead.  See ai-tools-prompt-detect.ts.
import { loadSettings } from './themes';
import {
  escapeShellSingle,
  exitCodeFromHook,
  setShellType,
  stripAnsi,
  truncateOutput,
  TOKEN_BUDGET,
} from './ai-tools-core';
import {
  EXIT_CODE_UNKNOWN,
  WATCH_DETECT_TAIL_CHARS,
  shouldCompleteFromPromptTail,
  userTypedRecently,
} from './ai-terminal-watch-lifecycle';
import {
  detectInteractiveState,
  describeState,
  endsWithShellPrompt,
  type InteractiveState,
  type PromptInfo,
} from './ai-tools-prompt-detect';

// ─── Per-session PTY lock ─────────────────────────────────────────
// The orchestrator parallelizes any tools whose handler is marked
// `isConcurrencySafe: true` (read_file, list_directory, glob_search,
// grep_search, …). That parallelism is fine when the work is local
// (the Rust commands are independent) but it would CORRUPT a shared
// PTY if two of those tools targeted the same SSH session — both
// would push commands into the same pty stream and the captured
// outputs would interleave.
//
// We solve this with a session-keyed promise queue: any caller that
// touches a session's PTY (sends input, observes output, captures
// command results) wraps its critical section in `withSessionPtyLock`,
// and the lock guarantees those critical sections execute serially
// PER SESSION while still allowing different sessions to run in
// parallel and allowing pure buffer reads (read_terminal, read_screen)
// to bypass entirely.
//
// The lock is intentionally cooperative — it only protects callers
// that opt in. The runLoop's orchestrator stays unchanged: tools are
// still grouped by `isConcurrencySafe`, and parallel batches still
// race on the JS event loop. The lock just ensures that when two
// "concurrency-safe" tools happen to land on the same session, the
// second one waits for the first to finish its PTY round-trip.

const sessionPtyTails = new Map<string, Promise<unknown>>();

/**
 * Serialize PTY interactions per session. Wrap any function that
 * sends input to or observes output from a specific session's PTY
 * in this helper. Calls on different sessions never block each
 * other; calls on the same session execute strictly in arrival
 * order.
 *
 * Errors from `fn` propagate to the caller normally — they do NOT
 * poison the queue, so a failed read_file does not block subsequent
 * tools on the same session.
 */
export function withSessionPtyLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sessionPtyTails.get(sessionId) ?? Promise.resolve();
  // Chain regardless of prev outcome (success → fn, failure → fn).
  // The shared tail is .catch'd before being stored so unhandled
  // rejections from earlier critical sections don't bubble out of
  // the queue. Map size is bounded by the number of live sessions,
  // not the number of calls — each session keeps exactly one tail
  // entry that is overwritten on every new acquire.
  const next = prev.then(fn, fn);
  sessionPtyTails.set(sessionId, next.catch(() => undefined));
  return next;
}

// ─── Shell State Machine ──────────────────────────────────────────
// The prompt hook (__meterm_precmd) sends OSC 7768 with exit code + CWD
// before each prompt. This drives the state machine:
//   unknown → ready (first OSC 7768) → agent_executing → ready (next OSC 7768)
//
// It is a HOOK-ONLY machine: nothing else can advance or reset it, so a
// hookless session parks at whatever it last was. That is why every reader of
// `phase` in this codebase is gated on `hookInjected` and why the hookless
// completion path below reads the screen tail instead — see ShellPhase in
// terminal-types.ts.

/**
 * Build the one-line precmd hook script for a given shell type.
 * Emits `OSC 7768;EXIT_CODE;CWD;LAST_CMD;DURATION_MS` before each prompt.
 *
 * The trailing `duration_ms` is **not** cosmetic: the Rust side turns
 * "duration ≥ 30s" into the "long command finished" push
 * (`server/session/mod.rs::notify_events_to_publish`). The OSC filter parses
 * the field as optional so 3-field hooks keep working — which is precisely how
 * this one shipped without it and silently disabled the feature. For that
 * reason the field is locked down by `tests/shell-hook-duration.test.mts`.
 *
 * Timers must be installed *before* the command runs, hence the preexec tweak
 * per shell: zsh `add-zsh-hook preexec` (needs `zmodload zsh/datetime` for
 * `EPOCHREALTIME`), bash a `DEBUG` trap (bash's `$(( ))` is integer-only, so
 * `EPOCHREALTIME` is split into seconds/microseconds and each half prefixed
 * with `10#` — otherwise a fraction like `012345` would be read as *octal*).
 *
 * `fish` and `powershell` deliberately still emit 3 fields: both are
 * unverifiable from this repo's test environment (no `fish`/`pwsh` binary, no
 * CI coverage), and a syntax error in an injected hook is *masked* — the
 * 7766 detect marker fires before the `eval`, so `hookInjected` would flip
 * true while the hook is dead. Add them only together with a way to verify.
 */
function buildShellHook(shellType: string): string {
  switch (shellType) {
    case 'zsh':
      return [
        `__meterm_cmd_start='';__meterm_cmd_running=0;`,
        `__meterm_preexec(){ __meterm_cmd_running=1;`,
        `if [ -n "\${EPOCHREALTIME:-}" ];then __meterm_cmd_start="$EPOCHREALTIME";else __meterm_cmd_start="$SECONDS";fi; };`,
        `__meterm_precmd(){ local e=$?;local c;local dur=0;`,
        `if [ -z "$__meterm_hook_ready" ];then export __meterm_hook_ready=1;c='';`,
        `else c=$(fc -ln -1 2>/dev/null);`,
        `if [ "$__meterm_cmd_running" = 1 ]&&[ -n "$__meterm_cmd_start" ]&&[ -n "\${EPOCHREALTIME:-}" ];then dur=$(( (EPOCHREALTIME - __meterm_cmd_start) * 1000 ));dur=\${dur%%.*};`,
        `case "$dur" in ''|*[!0-9-]*) dur=0;; esac;fi;fi;`,
        `__meterm_cmd_running=0;`,
        `printf '\\033]7768;%d;%s;%s;%d\\007' "$e" "$PWD" "$c" "$dur"; };`,
        `zmodload zsh/datetime 2>/dev/null;`,
        `autoload -Uz add-zsh-hook 2>/dev/null&&{ add-zsh-hook preexec __meterm_preexec; add-zsh-hook precmd __meterm_precmd; }`,
      ].join('');
    case 'fish':
      return [
        `function __meterm_postcmd --on-event fish_postexec;`,
        `if not set -q __meterm_hook_ready;set -gx __meterm_hook_ready 1;`,
        `printf '\\033]7768;%d;%s;\\007' $status "$PWD";`,
        `else;`,
        `printf '\\033]7768;%d;%s;%s\\007' $status "$PWD" "$argv";`,
        `end;`,
        `end`,
      ].join('');
    case 'powershell':
      return [
        `function prompt {`,
        `$e=$LASTEXITCODE;`,
        `if (-not $env:__meterm_hook_ready){$env:__meterm_hook_ready='1';$c=''}`,
        `else{$c=(Get-History -Count 1).CommandLine};`,
        `[Console]::Write("$([char]0x1b)]7768;$e;$(Get-Location);$c$([char]7)");`,
        `return "PS> "`,
        `}`,
      ].join('');
    default: // bash
      return [
        `__meterm_cmd_start='';__meterm_cmd_running=0;__meterm_in_prompt=0;`,
        `__meterm_preexec(){ [ -n "\${COMP_LINE:-}" ]&&return;`,
        `case "\${BASH_COMMAND:-}" in __meterm_precmd*) return;; esac;`,
        `[ "\${__meterm_in_prompt:-0}" = 1 ]&&return;`,
        `[ "\${__meterm_cmd_running:-0}" = 1 ]&&return;`,
        `__meterm_cmd_running=1;`,
        `if [ -n "\${EPOCHREALTIME:-}" ];then __meterm_cmd_start="$EPOCHREALTIME";else __meterm_cmd_start="\${EPOCHSECONDS:-$SECONDS}";fi; };`,
        `__meterm_precmd(){ local e=$?;local c;local dur=0;__meterm_in_prompt=1;`,
        `if [ -z "$__meterm_hook_ready" ];then export __meterm_hook_ready=1;c='';`,
        `else c=$(fc -ln -1 2>/dev/null);`,
        `if [ "\${__meterm_cmd_running:-0}" = 1 ]&&[ -n "\${__meterm_cmd_start:-}" ];then if [ -n "\${EPOCHREALTIME:-}" ];then local __s_sec=\${__meterm_cmd_start%.*};local __s_usec=\${__meterm_cmd_start#*.};`,
        `local __e_sec=\${EPOCHREALTIME%.*};local __e_usec=\${EPOCHREALTIME#*.};`,
        `dur=$(( (10#$__e_sec - 10#$__s_sec) * 1000 + (10#$__e_usec - 10#$__s_usec) / 1000 ));`,
        `else dur=$(( (\${EPOCHSECONDS:-$SECONDS} - \${__meterm_cmd_start%%.*}) * 1000 ));fi;`,
        `case "$dur" in ''|*[!0-9-]*) dur=0;; esac;`,
        `[ "$dur" -lt 0 ] 2>/dev/null&&dur=0;fi;fi;`,
        `__meterm_cmd_running=0;__meterm_in_prompt=0;`,
        `printf '\\033]7768;%d;%s;%s;%d\\007' "$e" "$PWD" "$c" "$dur"; };`,
        `trap '__meterm_preexec' DEBUG;`,
        `PROMPT_COMMAND="__meterm_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"`,
      ].join('');
  }
}

// ─── Shell Hook Injection ───────────────────────────────────────

/**
 * Per-session injection bookkeeping.
 *
 * Injection used to be strictly one-shot: a single `_injectionAttempted` flag
 * meant that a failed attempt — shell still busy, slow `.zshrc`, or the
 * injection landing while a TUI owned the screen — left that session hookless
 * for the rest of its life, with nothing but a `!` badge to show for it. Retry
 * with backoff instead, bounded so a genuinely hookless host is not hammered.
 */
interface HookInjectionState {
  /** Attempts spent so far. A blocked attempt counts: it *is* a retry cycle. */
  failures: number;
  /** Pending retry timer, if one is queued. */
  retryTimer: ReturnType<typeof setTimeout> | null;
}

/** Delays between attempts. Length + 1 = total attempts (1 initial + 3 retries). */
const HOOK_RETRY_BACKOFF_MS = [5_000, 15_000, 60_000];

/** How long the handshake waits for the 7766 detect marker. */
const HOOK_INJECTION_TIMEOUT_MS = 3000;

const _injectionState = new Map<string, HookInjectionState>();

/**
 * Is something other than the shell currently owning the terminal?
 *
 * The injection writes `Ctrl-U` + a command line + `\n`. Typed into a program
 * that has taken over the screen, none of that injects anything — it feeds the
 * text straight to that program: vim/less get a stray edit, `top` gets a bogus
 * keystroke. Silent-2s (the trigger in `ai-capsule-terminal-capture.ts`) is
 * equally true of `vim`, so this guard is what keeps the injection from typing
 * into them.
 *
 * Known gap: a *nested* `ssh` shows the remote's prompt, which the detector
 * reads as a bare shell prompt (`active`) — so this does not catch that case,
 * and the injection would land on the wrong host. Detecting it needs a signal
 * we do not have cheaply; the attempt still fails the handshake and is retried,
 * so the cost is a lost attempt rather than a corrupted screen.
 */
function injectionBlocked(sessionId: string): boolean {
  try {
    // Checked explicitly rather than delegated: this is a safety guard, and it
    // should not hinge on the detector's internal short-circuit order (it does
    // return 'tui' for alt-screen today, but that is its business, not ours).
    const altScreen = isAlternateScreen(sessionId);
    if (altScreen) return true;

    const tail = (TerminalRegistry.serializeBuffer(sessionId) ?? '')
      .slice(-WATCH_DETECT_TAIL_CHARS);
    return detectInteractiveState(tail, altScreen).state !== 'active';
  } catch {
    return false; // unreadable screen must not block injection
  }
}

/**
 * Book one spent attempt and queue the next, or stop once they run out.
 * Also used for *blocked* attempts, which are the retryable case by nature:
 * the TUI/prompt occupying the screen is usually gone seconds later.
 */
function scheduleHookRetry(sessionId: string): void {
  const state = _injectionState.get(sessionId) ?? { failures: 0, retryTimer: null };
  state.failures += 1;
  _injectionState.set(sessionId, state);

  const delay = HOOK_RETRY_BACKOFF_MS[state.failures - 1];
  if (delay === undefined) return; // attempts exhausted

  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    // Session went away while we waited — drop the bookkeeping rather than
    // retry into a dead terminal (this is the only cleanup path we get, since
    // importing this module from terminal.ts would be a cycle).
    if (!TerminalRegistry.get(sessionId)) {
      _injectionState.delete(sessionId);
      return;
    }
    injectShellHook(sessionId);
  }, delay);
}

/** Forget a session's retry bookkeeping once the hook is in place. */
function clearHookRetry(sessionId: string): void {
  const state = _injectionState.get(sessionId);
  if (state?.retryTimer) clearTimeout(state.retryTimer);
  _injectionState.delete(sessionId);
}

/**
 * Inject the shell prompt hook into the terminal session (SSH/remote fallback).
 *
 * For local shells, the Go sidecar pre-installs the hook via ZDOTDIR (zsh) or
 * --rcfile (bash), making this function a no-op (hookInjected is already true
 * from the first OSC 7768 received).
 *
 * For SSH/remote shells, uses the xterm.js **alternate screen buffer**:
 *   1. Switch to alt screen (main screen with MOTD/prompt is preserved)
 *   2. Send injection command (all echo goes to alt screen)
 *   3. Wait for completion
 *   4. Switch back to main screen (alt screen discarded)
 */
export function injectShellHook(sessionId: string): boolean {
  const mt = TerminalRegistry.get(sessionId);
  if (!mt) {
    _injectionState.delete(sessionId);
    return false;
  }
  if (mt.shellState.hookInjected) {
    clearHookRetry(sessionId);
    return true;
  }
  // Check settings — user can disable SSH hook injection
  if (!loadSettings().shellHookInjection) return false;

  const state = _injectionState.get(sessionId);
  // A retry is already queued; do not stack another handshake on top of it.
  if (state?.retryTimer) return false;
  // Every attempt spent — stop for good (matches the old one-shot behaviour,
  // minus the part where "one shot" meant "one attempt").
  if (state && state.failures > HOOK_RETRY_BACKOFF_MS.length) return false;

  if (injectionBlocked(sessionId)) {
    scheduleHookRetry(sessionId);
    return false;
  }
  return _injectShellHookImpl(sessionId, mt);
}

function _injectShellHookImpl(
  sessionId: string,
  mt: ReturnType<typeof TerminalRegistry.get> & {},
): boolean {
  const zshHook = buildShellHook('zsh');
  const bashHook = buildShellHook('bash');
  const fishHook = buildShellHook('fish');
  const detectId = `det_${Date.now().toString(36)}`;

  // Single-line polyglot: `test -n` guards ensure only the matching branch runs.
  // __meterm_hook_ready guard: skip if Go sidecar already installed the hook.
  const cmd = [
    ` test -n "$ZSH_VERSION" && test -z "$__meterm_hook_ready" &&`,
    `printf '\\033]7766;${detectId};1\\007' &&`,
    `eval '${escapeShellSingle(zshHook)}' &&`,
    `setopt HIST_IGNORE_SPACE 2>/dev/null;`,
    `test -n "$BASH_VERSION" && test -z "$__meterm_hook_ready" &&`,
    `printf '\\033]7766;${detectId};0\\007' &&`,
    `eval '${escapeShellSingle(bashHook)}' &&`,
    `history -d $HISTCMD 2>/dev/null;`,
    `export HISTCONTROL="\${HISTCONTROL:+\$HISTCONTROL:}ignorespace";`,
    `test -n "$FISH_VERSION" && test -z "$__meterm_hook_ready" &&`,
    `printf '\\033]7766;${detectId};2\\007' &&`,
    `eval '${escapeShellSingle(fishHook)}';`,
    `printf '\\0338\\033[0J\\033[0m\\r\\033[2K'`,
  ].join(' ');

  // Switch to alternate screen buffer BEFORE sending.
  mt.terminal.write('\x1b[?1049h');

  TerminalRegistry.sendInput(sessionId, '\x15' + cmd + '\n');

  const restoreScreen = () => {
    mt.terminal.write('\x1b[?1049l');
    mt.terminal.scrollToBottom();
  };

  const timeout = setTimeout(() => {
    unsub();
    restoreScreen();
    // No detect marker: the shell never ran (still busy, slow rc, echoed into
    // a program that swallowed it). Queue another attempt.
    scheduleHookRetry(sessionId);
  }, HOOK_INJECTION_TIMEOUT_MS);
  const unsub = TerminalRegistry.onOscMarker(sessionId, detectId, (code) => {
    clearTimeout(timeout);
    restoreScreen();
    // The marker is emitted inside the `test -z "$__meterm_hook_ready"` guard,
    // so receiving one means a shell branch really ran. (The old `code !== -1`
    // test was dead: resolver() coerces NaN to 0, so code ∈ {0,1,2}.)
    setShellType(sessionId, code === 1 ? 'zsh' : code === 2 ? 'fish' : 'bash');
    mt.shellState.hookInjected = true;
    clearHookRetry(sessionId);
  });

  return false; // hookInjected will be set asynchronously via callback
}

// ─── Command Execution Waiters ──────────────────────────────────
//
// These two waiters now share a single detection strategy:
//
//   1. Shell-hook idle (OSC 7768) — the BEST signal. Means the shell
//      is back at its prompt and the command truly finished. Resolves
//      as status='completed' with the real exit code + cwd.
//
//   2. Interactive-state detector — after ~1.5 seconds of silence
//      following actual output, we inspect the tail of the buffer
//      for password/confirm/TUI patterns (ai-tools-prompt-detect.ts).
//      If we find one, we RESOLVE EARLY with a specific status so the
//      LLM knows to use type_text / press_keys / watch_terminal. We do NOT fake
//      an exit code.
//
//   3. xterm.js alternate-screen buffer — checked alongside (2).
//      If the terminal switched to alt-screen, the foreground process
//      has taken over the display (vim/top/htop/less/etc). We resolve
//      as 'tui'.
//
//   4. Hard deadline — if none of the above fire within timeoutSec,
//      we resolve as 'timeout' (command may still be running).
//
// Critically, we NEVER fake an OSC 7766 marker via `inject_osc_marker`
// anymore. That hack caused run_command to lie about completion
// whenever a process blocked the PTY waiting for input.

/** Status of a terminal wait, reflecting WHY we stopped waiting. */
export type WaitStatus =
  | 'completed'          // shell hook fired — command truly finished
  | 'waiting_password'   // detector saw a password prompt
  | 'waiting_confirm'    // detector saw a Y/n prompt
  | 'waiting_input'      // detector saw a generic "xxx:" prompt tail
  | 'tui'                // xterm alt-screen flipped on
  | 'idle_no_signal'     // silent for a long time, no shell hook
  | 'timeout'            // hit the hard deadline
  | 'aborted';           // external abort signal

export interface WaitResult {
  output: string;
  exitCode: number;
  cwd: string;
  status: WaitStatus;
  /** Optional prompt line that triggered the detector (for LLM hints). */
  detectorLine?: string;
  /** Structured prompt info when a library-specific parser matched. */
  promptInfo?: PromptInfo;
}

/** Configuration for the hybrid wait loop. */
interface WaitOptions {
  /** Hard deadline in seconds. */
  timeoutSec: number;
  /** Silence threshold before the detector fires (ms). */
  detectAfterSilenceMs: number;
  /** Silence threshold before we give up with idle_no_signal (ms). */
  giveUpAfterSilenceMs: number;
}

/**
 * Read the current xterm buffer type. Returns true iff the terminal is
 * in alternate-screen mode (TUI program has taken over).
 */
function isAlternateScreen(sessionId: string): boolean {
  const mt = TerminalRegistry.get(sessionId);
  try {
    return mt?.terminal.buffer.active.type === 'alternate';
  } catch {
    return false;
  }
}

/**
 * Map a detector state → wait status (1:1 except 'active').
 */
function detectorToStatus(state: InteractiveState): WaitStatus | null {
  switch (state) {
    case 'waiting_password': return 'waiting_password';
    case 'waiting_confirm':  return 'waiting_confirm';
    case 'waiting_input':    return 'waiting_input';
    case 'tui':              return 'tui';
    case 'active':           return null;
  }
}

/**
 * Core wait loop — listens for output, shell-idle, and periodically
 * runs the interactive-state detector.  Used by BOTH the hook-enabled
 * path and the hookless fallback; the only difference is whether
 * onShellIdle will ever fire.
 */
function runWaitLoop(
  sessionId: string,
  options: WaitOptions,
  signal?: { aborted: boolean },
): Promise<WaitResult> {
  const { timeoutSec, detectAfterSilenceMs, giveUpAfterSilenceMs } = options;
  // Baseline alt-screen state captured BEFORE the command is sent.
  // This lets us distinguish "the command just entered a TUI" from
  // "we were already inside tmux/screen/vim from a previous command".
  // We only report status='tui' when the flag flips false → true.
  const baselineAltScreen = isAlternateScreen(sessionId);

  return new Promise((resolve) => {
    let outputBuffer = '';
    let resolved = false;
    let lastOutputTime = Date.now();
    let hadAnyOutput = false;

    // Read fresh on every check: the hook can finish being injected, and
    // the user can type, while this command is still in flight.
    const hookAlive = () => !!TerminalRegistry.get(sessionId)?.shellState.hookInjected;
    const userTypedJustNow = () => userTypedRecently(
      TerminalRegistry.get(sessionId)?.shellState.lastUserInputAt ?? 0,
      Date.now(),
    );

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      unsubOutput();
      unsubIdle();
      clearTimeout(deadline);
      clearInterval(checkTimer);
    };

    const finish = (result: WaitResult) => {
      if (resolved) return;
      cleanup();
      resolve(result);
    };

    // ── Hard deadline ──
    const deadline = setTimeout(() => {
      const mt = TerminalRegistry.get(sessionId);
      finish({
        output: stripAnsi(outputBuffer)
          + `\n[Command timed out after ${timeoutSec}s — may still be running]`,
        exitCode: -1,
        cwd: mt?.shellState.cwd ?? '',
        status: 'timeout',
      });
    }, timeoutSec * 1000);

    // ── Periodic detector check ──
    // Runs every 300ms and checks, in order:
    //   (a) External abort signal was set — stop immediately even
    //       if no output has arrived (silent process case).
    //   (b) Did alt-screen flip on? → status='tui' (baseline-aware).
    //   (c) Been silent for detectAfterSilenceMs? → run the
    //       interactive-state detector on the buffer tail.
    //   (d) Been silent for giveUpAfterSilenceMs? → 'idle_no_signal'.
    const checkTimer = setInterval(() => {
      if (resolved) return;

      // (a) Abort check runs every tick so Ctrl+C works even when
      // the child process is dead silent (no output events arrive).
      if (signal?.aborted) {
        finish({
          output: stripAnsi(outputBuffer) + '\n[执行被用户中止]',
          exitCode: -1,
          cwd: '',
          status: 'aborted',
        });
        return;
      }

      const silentMs = Date.now() - lastOutputTime;

      // (a) alt-screen transition (only if we didn't already start
      // inside an alt-screen session like tmux — otherwise we'd
      // always trigger 'tui' and never listen to the real signals).
      if (!baselineAltScreen && isAlternateScreen(sessionId)) {
        const mt = TerminalRegistry.get(sessionId);
        finish({
          output: stripAnsi(outputBuffer),
          exitCode: 0,
          cwd: mt?.shellState.cwd ?? '',
          status: 'tui',
        });
        return;
      }

      // (b) Prompt detector only makes sense once we've actually seen
      // some output AND the stream has been silent for a beat — a
      // command that's still streaming output is clearly not waiting.
      if (hadAnyOutput && silentMs >= detectAfterSilenceMs) {
        const detect = detectInteractiveState(outputBuffer, false);
        // When we're already inside a tmux alt-screen we must NOT
        // report 'tui' from the detector (detectInteractiveState
        // also honors the altScreen flag, so pass false here to
        // skip that shortcut — we handled alt-screen above).
        const status = detectorToStatus(detect.state);
        if (status && status !== 'tui') {
          const mt = TerminalRegistry.get(sessionId);
          finish({
            output: stripAnsi(outputBuffer),
            exitCode: 0,
            cwd: mt?.shellState.cwd ?? '',
            status,
            detectorLine: detect.matchedLine,
            promptInfo: detect.promptInfo,
          });
          return;
        }

        // (b') Hookless shell prompt completion fallback:
        // When OSC 7768 isn't available, the buffer tail being a
        // shell prompt ("$ "/"# "/"% "/"> ") after silence is the
        // best "command finished" signal we have — but it is only
        // evidence when the hook cannot speak for this session AND the
        // prompt is not one the user just produced. With a hook present
        // the onShellIdle listener below is authoritative, and a
        // prompt-shaped tail would hand us the PREVIOUS command's exit
        // code instead of this one's.
        const tailIsPrompt = endsWithShellPrompt(outputBuffer);
        if (shouldCompleteFromPromptTail({
          hookInjected: hookAlive(),
          recentUserInput: userTypedJustNow(),
          tailIsPrompt,
        })) {
          finish({
            output: stripAnsi(outputBuffer)
              + '\n[exit code unavailable: this session has no shell hook]',
            // Visual detection can never know the real exit status, so
            // say so instead of reporting lastExitCode — without a hook
            // that field keeps its initial 0, which would report every
            // failed command as a success.
            exitCode: EXIT_CODE_UNKNOWN,
            cwd: TerminalRegistry.get(sessionId)?.shellState.cwd ?? '',
            status: 'completed',
          });
          return;
        }
      }

      // (c) Give-up path: silent for a long time AND still no shell
      // hook AND no detector match AND no prompt tail. Return what
      // we have so the caller can decide.
      if (hadAnyOutput && silentMs >= giveUpAfterSilenceMs) {
        finish({
          output: stripAnsi(outputBuffer)
            + `\n[No shell-idle signal for ${Math.round(silentMs/1000)}s; the process may still be running or waiting]`,
          exitCode: exitCodeFromHook(sessionId),
          cwd: TerminalRegistry.get(sessionId)?.shellState.cwd ?? '',
          status: 'idle_no_signal',
        });
      }
    }, 300);

    // ── Output listener ──
    const unsubOutput = TerminalRegistry.onOutput(sessionId, (data) => {
      if (resolved) return;
      if (signal?.aborted) {
        finish({
          output: stripAnsi(outputBuffer) + '\n[执行被用户中止]',
          exitCode: -1,
          cwd: '',
          status: 'aborted',
        });
        return;
      }
      outputBuffer += data;
      hadAnyOutput = true;
      lastOutputTime = Date.now();
    });

    // ── Shell hook idle (OSC 7768) — authoritative "command done". ──
    const unsubIdle = TerminalRegistry.onShellIdle(sessionId, () => {
      finish({
        output: stripAnsi(outputBuffer),
        // The 7768 handler writes lastExitCode immediately before
        // firing this event, so this is the real exit status of the
        // command we are waiting on.
        exitCode: exitCodeFromHook(sessionId),
        cwd: TerminalRegistry.get(sessionId)?.shellState.cwd ?? '',
        status: 'completed',
      });
    });
  });
}

// ─── Execute Agent Command ──────────────────────────────────────

/**
 * Execute a command in the terminal and wait for it to complete, block,
 * or enter an interactive state.  Returns a structured result the
 * caller can surface to the LLM.
 *
 * Strategy differences vs. the old implementation:
 *
 *   • No more synthetic OSC 7766 marker injection. That caused
 *     run_command to return success while the process was still
 *     blocking on a password prompt.
 *
 *   • No more `; printf '...7766...'` suffix on the command. That
 *     never fires for interactive/TUI programs anyway and caused
 *     confusing echoes in the terminal.
 *
 *   • A single `runWaitLoop` handles both hook-enabled and hookless
 *     paths. The only difference is that without the shell hook,
 *     'completed' status will never fire — the loop resolves via
 *     detector / alt-screen / idle_no_signal / timeout instead.
 */
export async function executeAgentCommand(
  sessionId: string,
  cmd: string,
  shellType: string,
  timeoutSec: number,
  signal?: { aborted: boolean },
): Promise<{
  output: string;
  exitCode: number;
  cwd: string;
  status: WaitStatus;
  detectorLine?: string;
  promptInfo?: PromptInfo;
}> {
  // Acquire the per-session PTY lock so that any other tool currently
  // touching this session's PTY (run_command, type_text, press_keys,
  // watch_terminal, or any SSH-routed read_file / write_file /
  // list_directory / glob_search / grep_search) finishes before we
  // send our command. Without this, the orchestrator would happily
  // fan out 5 read_files / list_directories / grep_searches in
  // parallel on the same SSH session and the captured outputs would
  // interleave on the wire, corrupting all of them.
  return withSessionPtyLock(sessionId, async () => {
    const mt = TerminalRegistry.get(sessionId);
    const hookReady = !!mt?.shellState.hookInjected && shellType !== 'powershell';

    const waitOpts = hookReady
      ? { timeoutSec, detectAfterSilenceMs: 1_500, giveUpAfterSilenceMs: 30_000 }
      : { timeoutSec, detectAfterSilenceMs: 1_500, giveUpAfterSilenceMs: 5_000 };

    const resultPromise = runWaitLoop(sessionId, waitOpts, signal);
    TerminalRegistry.sendAgentCommand(sessionId, ` ${cmd}`, shellType);
    const result = await resultPromise;

    return {
      output: cleanOutput(result.output, cmd),
      exitCode: result.exitCode,
      cwd: result.cwd,
      status: result.status,
      detectorLine: result.detectorLine,
      promptInfo: result.promptInfo,
    };
  });
}

/**
 * Execute a command via terminal and capture output (used by read_file/write_file on SSH).
 * Returns only the text portion — interactive status is discarded,
 * which is fine because these helpers wrap simple, non-interactive
 * commands (head, cat > heredoc, etc.).
 */
export async function executeViaTerminal(
  sessionId: string,
  cmd: string,
  timeoutSec = 15,
  shellType = 'bash',
): Promise<string> {
  const { output } = await executeAgentCommand(sessionId, cmd, shellType, timeoutSec);
  return truncateOutput(output, TOKEN_BUDGET.perToolOutputChars);
}

/** Re-export for external consumers (run_command) that need the state label. */
export { describeState };

/**
 * Clean captured output: strip command echo line and trailing prompt lines.
 */
export function cleanOutput(raw: string, sentCommand?: string): string {
  const lines = stripAnsi(raw).split('\n');

  // Strip command echo (first occurrence within first 3 lines)
  let start = 0;
  if (sentCommand) {
    const cmdText = sentCommand.trim();
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      if (lines[i].includes(cmdText)) { start = i + 1; break; }
    }
  }

  // Strip trailing blank/prompt lines
  let end = lines.length;
  for (let i = lines.length - 1; i >= start; i--) {
    const t = lines[i].trim();
    if (t === '' || /^.*[\$#%>]\s*$/.test(t)) end = i;
    else break;
  }

  return lines.slice(start, end).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Session teardown ────────────────────────────────────────────
// Both maps in this module are keyed by session id and were only ever written
// to, so a long-running window accumulated one entry per session it had ever
// opened. Retry bookkeeping had a self-clean path (the retry timer notices a
// dead session) but a cancelled timer never fires, and the PTY tail map had
// none at all. Register with the registry instead of importing terminal.ts's
// teardown — that import would be a cycle, which is exactly why this was left
// undone.
TerminalRegistry.onSessionDisposed((sessionId) => {
  // Drop the serialization tail: nothing can be in flight for a session whose
  // terminal is gone, and keeping a resolved promise alive would pin the
  // closure chain it chained onto.
  sessionPtyTails.delete(sessionId);
  // Cancels a pending retry timer as well as the record.
  clearHookRetry(sessionId);
});
