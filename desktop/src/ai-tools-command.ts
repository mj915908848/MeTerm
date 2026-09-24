// ─── AI Tools: Command / Terminal Interaction Tools ─────────────
// run_command, read_terminal, type_text, press_keys, watch_terminal
// All tools that interact with the live terminal session.

import { TerminalRegistry } from './terminal';
import {
  ToolHandler,
  TOKEN_BUDGET,
  exitCodeFromHook,
  stripAnsi,
  truncateOutput,
  isDangerousCommand,
  isExtremelyDangerous,
  resolvePaneTarget,
  type PaneInfo,
  type ToolContext,
} from './ai-tools-core';
import { executeAgentCommand, withSessionPtyLock } from './ai-tools-shell';
import {
  createWatchLifecycle,
  watchTimeoutSeconds,
  precheckWatch,
  EXIT_CODE_UNKNOWN,
  shouldCompleteFromPromptTail,
  userTypedRecently,
  lastMatchingLine,
  tailOf,
  WATCH_DETECT_SILENCE_MS,
  WATCH_DETECT_TAIL_CHARS,
  WATCH_PROMPT_SETTLE_MS,
} from './ai-terminal-watch-lifecycle';
import { detectInteractiveState, endsWithShellPrompt } from './ai-tools-prompt-detect';
import {
  isShellPromptVisible,
  watchForPromptReturn,
  type PromptReturnWatch,
} from './ai-wait-prompt-return';
import { resolveSingleKey } from './ai-tools-keys';
import { waitAutoDetectedReason } from './ai-tool-i18n';

// ─── Pre-emptive wait card lifecycle ────────────────────────────
//
// Decouples "show waiting UI" from "LLM decides to call
// wait_for_user_input". For password prompts (high-confidence) the
// frontend dispatches the wait card the moment run_command returns,
// runs its own input/shell-idle listeners, and the LLM's
// wait_for_user_input call later ADOPTS this card.
//
// Design notes (after iterating away from a marker-based approach):
//   • There is exactly ONE source of truth for "is the wait done":
//     `mt.shellState.phase === 'ready'`. The previous design layered
//     a `recentlyCompletedWaits` Map on top with a 30s expiry, but
//     that introduced cross-command bleed (a marker from an unrelated
//     earlier pre-wait could be consumed by a later, unrelated
//     wait_for_user_input call). Reading phase directly is exact.
//   • `wait_for_user_input` checks phase up-front: if shell is already
//     ready it returns completed immediately (the busy→idle transition
//     that powers shell-idle has already happened — registering a fresh
//     listener now would never fire and the tool would hang to timeout).
//   • `startPreWait` is idempotent per session and tears down any
//     stale pre-wait first, so a model that runs run_command twice in
//     a row never gets a doubled card.
//   • A 10-minute hard cap protects against the orphan case where the
//     agent run was aborted mid-flight (Stop button) and no further
//     tool will ever come along to clean up the card.

interface PreWaitState {
  cardId: string;
  startedAt: number;
  unsubInput: () => void;
  unsubIdle: () => void;
  unsubCancel: () => void;
  /** Hookless fallback watcher (see ai-wait-prompt-return.ts). */
  promptWatch: PromptReturnWatch | null;
  hardTimeout: ReturnType<typeof setTimeout>;
}
const activePreWaits = new Map<string, PreWaitState>();

/** Pre-wait card auto-dismisses after this long if neither shell-idle
 *  nor LLM adoption nor user cancel happens — guards against orphans
 *  from an aborted agent run. */
const PRE_WAIT_HARD_TIMEOUT_MS = 10 * 60 * 1000;

function teardownPreWait(state: PreWaitState): void {
  state.unsubInput();
  state.unsubIdle();
  state.unsubCancel();
  state.promptWatch?.cancel();
  clearTimeout(state.hardTimeout);
}

/**
 * Show a wait card NOW, without waiting for an LLM round-trip.
 * Idempotent per session — if a pre-wait is already active for this
 * session it is torn down first (defensive: any stale state from a
 * previous prompt is irrelevant once a fresh one arrives).
 */
function startPreWait(sessionId: string, reason: string): string {
  // Defensive: a model that fires two run_commands back-to-back
  // shouldn't end up with two cards. Tear down whatever's there.
  const stale = activePreWaits.get(sessionId);
  if (stale) {
    activePreWaits.delete(sessionId);
    teardownPreWait(stale);
    try {
      document.dispatchEvent(
        new CustomEvent('ai-wait-for-user-input-end', {
          detail: { cardId: stale.cardId, status: 'aborted' },
        }),
      );
    } catch { /* ignore */ }
  }

  const cardId = `prewait-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;

  // Mount the card NOW — this is a synchronous DOM creation via the
  // ai-pre-wait-mount listener in ai-capsule-tool-ui.ts. Critically,
  // this does NOT go through the agent's tool_call_start path (which
  // only fires once the LLM has called the tool), so the user sees
  // the card before the LLM round-trip completes.
  document.dispatchEvent(
    new CustomEvent('ai-pre-wait-mount', {
      detail: { sessionId, cardId, reason, timeoutSec: 600 },
    }),
  );

  let receivedFired = false;
  const dispatchReceived = () => {
    if (receivedFired) return;
    receivedFired = true;
    try {
      document.dispatchEvent(
        new CustomEvent('ai-wait-for-user-input-received', { detail: { cardId } }),
      );
    } catch { /* ignore */ }
  };

  const unsubInput = TerminalRegistry.onInput(sessionId, () => dispatchReceived());

  const unsubIdle = TerminalRegistry.onShellIdle(sessionId, () => {
    const cur = activePreWaits.get(sessionId);
    if (!cur || cur.cardId !== cardId) return;
    activePreWaits.delete(sessionId);
    teardownPreWait(cur);
    try {
      document.dispatchEvent(
        new CustomEvent('ai-wait-for-user-input-end', {
          detail: { cardId, status: 'completed' },
        }),
      );
    } catch { /* ignore */ }
  });

  // Hookless fallback: OSC 7768 only ever fires when the shell hook is
  // injected. On an SSH session without it the card would stay at
  // "waiting" forever even though the user already typed the password
  // and the command returned to its prompt — watch the buffer tail the
  // same way run_command does. Only armed once the user has typed, so a
  // prompt that was on screen all along can't complete the card.
  const promptWatch = watchForPromptReturn(sessionId, () => receivedFired, () => {
    const cur = activePreWaits.get(sessionId);
    if (!cur || cur.cardId !== cardId) return;
    activePreWaits.delete(sessionId);
    teardownPreWait(cur);
    try {
      document.dispatchEvent(
        new CustomEvent('ai-wait-for-user-input-end', {
          detail: { cardId, status: 'completed' },
        }),
      );
    } catch { /* ignore */ }
  });

  // If the user clicks "Cancel" on the pre-emptive card before the
  // LLM has caught up, just dismiss the card.
  const onCancel = (e: Event) => {
    const ev = e as CustomEvent<{ cardId: string }>;
    if (ev.detail?.cardId !== cardId) return;
    const cur = activePreWaits.get(sessionId);
    if (!cur || cur.cardId !== cardId) return;
    activePreWaits.delete(sessionId);
    teardownPreWait(cur);
    try {
      document.dispatchEvent(
        new CustomEvent('ai-wait-for-user-input-end', {
          detail: { cardId, status: 'aborted' },
        }),
      );
    } catch { /* ignore */ }
  };
  document.addEventListener('ai-wait-for-user-input-cancel', onCancel);
  const unsubCancel = () =>
    document.removeEventListener('ai-wait-for-user-input-cancel', onCancel);

  // Orphan guard. If neither shell-idle nor cancel nor adoption ever
  // happens (e.g. the agent run was aborted right after run_command
  // returned), dismiss the card so it doesn't linger forever.
  const hardTimeout = setTimeout(() => {
    const cur = activePreWaits.get(sessionId);
    if (!cur || cur.cardId !== cardId) return;
    activePreWaits.delete(sessionId);
    teardownPreWait(cur);
    try {
      document.dispatchEvent(
        new CustomEvent('ai-wait-for-user-input-end', {
          detail: { cardId, status: 'timeout' },
        }),
      );
    } catch { /* ignore */ }
  }, PRE_WAIT_HARD_TIMEOUT_MS);

  activePreWaits.set(sessionId, {
    cardId,
    startedAt: Date.now(),
    unsubInput,
    unsubIdle,
    unsubCancel,
    promptWatch,
    hardTimeout,
  });
  return cardId;
}

/** Called by wait_for_user_input. Hands over the live pre-wait card
 *  (if any) to the caller and detaches the pre-wait's listeners.
 *  Returns null when there's no live pre-wait (either none was ever
 *  started, or it was already resolved by shell-idle / cancel /
 *  hard-timeout). */
function consumeActivePreWait(sessionId: string): { cardId: string } | null {
  const state = activePreWaits.get(sessionId);
  if (!state) return null;
  activePreWaits.delete(sessionId);
  teardownPreWait(state);
  return { cardId: state.cardId };
}

/**
 * Shared pane-parameter schema fragment. Every terminal tool exposes
 * an optional `pane: <number>` that routes the call to a non-default
 * pane of the same tab.
 */
const PANE_PARAM_SCHEMA = {
  type: 'number',
  description: 'Optional target pane number (1-based). Omit to use the default target (the pane the user focused when they hit Send). Invalid numbers return an error.',
} as const;

/**
 * Resolve the pane target and return a `[pane: N]` prefix for tool
 * result messages, or an error string. When the pane equals the
 * default target, the prefix is omitted (cleaner results).
 */
function paneHeaderFor(ctx: ToolContext, pane: PaneInfo): string {
  if (pane.isDefaultTarget) return '';
  return `[pane: ${pane.paneNumber}]\n`;
}

/** Real UTF-8 byte length of a JS string (not UTF-16 code units). */
function utf8ByteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Read xterm.js's alternate-screen flag for a session. */
function isAlternateScreen(sessionId: string): boolean {
  const mt = TerminalRegistry.get(sessionId);
  try {
    return mt?.terminal.buffer.active.type === 'alternate';
  } catch {
    return false;
  }
}

/**
 * Build a structured `[Terminal: ...]` line describing the TUI lifecycle
 * transition that just happened. Used by type_text / press_keys / run_command
 * so the LLM has an authoritative, machine-readable signal for whether it
 * is currently inside a TUI — instead of guessing from output bytes.
 *
 * Caller passes in the alt-screen state captured BEFORE the action; this
 * helper reads the CURRENT state and emits one of four labels.
 */
function formatTerminalStateLine(sessionId: string, wasAlt: boolean): string {
  const nowAlt = isAlternateScreen(sessionId);
  if (wasAlt && nowAlt) {
    return '[Terminal: TUI active — use read_screen to see what is on screen. Do NOT use read_terminal or watch_terminal for TUI inspection — they return raw cursor-positioning escapes that do NOT match what the user sees.]';
  }
  if (wasAlt && !nowAlt) {
    return '[Terminal: TUI just exited — you are back at the shell prompt. STOP sending TUI exit keys (q / :q / Ctrl-C). Resume normal shell commands via run_command.]';
  }
  if (!wasAlt && nowAlt) {
    return '[Terminal: TUI just started — call read_screen to see what is displayed before issuing more keys.]';
  }
  return '[Terminal: shell prompt — no TUI active.]';
}

/** Sleep helper for the post-action settle window. */
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Reusable security gate: refuse to write the PTY when the screen
 * is showing a password prompt.  Returns an error string when the
 * call should be refused, or null to proceed. */
function checkPasswordGate(sessionId: string): string | null {
  const buf = TerminalRegistry.serializeBuffer(sessionId) ?? '';
  const det = detectInteractiveState(buf, false);
  if (det.state === 'waiting_password') {
    return 'Error: REFUSED — the terminal is showing a password prompt. '
      + 'Agents MUST NOT send passwords through this tool under any circumstances, '
      + 'and MUST NOT ask the user for a password in the chat. '
      + 'Call wait_for_user_input with a clear `reason` instead.';
  }
  return null;
}
import { captureTerminalScreen } from './ai-tools-screen';
import type { ToolOutputWithImages } from './ai-tools-core';

// ─── run_command ─────────────────────────────────────────────────

export function createRunCommandTool(): ToolHandler {
  return {
    definition: {
      name: 'run_command',
      description:
        'Execute a shell command and wait for it to complete. Returns a status header so you can see whether the command finished, is waiting for input, or entered a full-screen TUI.\n' +
        '\n' +
        'Status values you may see at the top of the result (detailed next-step hint is appended to every non-completed status):\n' +
        '  [status: completed]         — command finished, exit code included\n' +
        '  [status: waiting_password]  — a password/passphrase prompt was detected — you MUST call wait_for_user_input (type_text / press_keys are refused on password prompts)\n' +
        '  [status: waiting_confirm]   — a Y/n prompt was detected — respond with type_text("y") + press_keys("Enter")\n' +
        '  [status: waiting_input]     — a generic prompt was detected — inspect context with watch_terminal, then type_text the value + press_keys("Enter") (or wait_for_user_input if sensitive)\n' +
        '  [status: tui]               — the command entered a full-screen TUI (vim, top, less…) — exit it with press_keys("q") / press_keys("Ctrl-C") / etc. before running anything else\n' +
        '  [status: idle_no_signal]    — the command is still running but silent — use watch_terminal to observe further output\n' +
        '  [status: timeout]           — hit the timeout — the command may still be running; use watch_terminal to check\n' +
        '\n' +
        'When status is anything other than "completed", do NOT issue another run_command until you have resolved the current state.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute (single command)' },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds to wait for output (default: 30)',
            default: 30,
          },
          pane: PANE_PARAM_SCHEMA,
        },
        required: ['command'],
      },
    },

    // run_command mutates terminal state → never concurrent.
    isConcurrencySafe: false,

    requiresConfirm(args) {
      return isDangerousCommand(args.command as string);
    },

    isDestructive(args) {
      return isExtremelyDangerous(args.command as string);
    },

    async execute(args, ctx): Promise<string> {
      const cmd = args.command as string;
      const timeout = (args.timeout as number) || 30;

      const resolved = resolvePaneTarget(ctx, args.pane);
      if (!resolved.ok) return `Error: ${resolved.error}`;
      const pane = resolved.pane;

      const mt = TerminalRegistry.get(pane.sessionId);
      const connected = (mt?.transport && mt.transport.connected) || (mt?.ws && mt.ws.readyState === WebSocket.OPEN);
      if (!connected) {
        return `${paneHeaderFor(ctx, pane)}Error: terminal connection lost`;
      }

      const {
        output: raw, exitCode, cwd, status, detectorLine, promptInfo,
      } = await executeAgentCommand(
        pane.sessionId, cmd, pane.shellType, timeout,
      );
      // executeAgentCommand already stripped ANSI + command echo + trailing
      // prompt lines via cleanOutput() — we only need size-limit truncation.
      const output = truncateOutput(raw, TOKEN_BUDGET.perToolOutputChars);

      // Update CWD in tool context for the default target only.
      if (cwd && pane.isDefaultTarget) ctx.cwd = cwd;

      // ── Build a structured header so the LLM can distinguish
      //    "done" from "stuck on a prompt".  We always surface the
      //    status — even for 'completed' — so the contract is
      //    consistent from the model's point of view.
      let header = `[status: ${status}`;
      if (status === 'completed') {
        header += `, exit: ${exitCode}`;
      } else if (detectorLine) {
        // Include the matched prompt line verbatim so the LLM can
        // quote it back when explaining what it's doing.
        header += `, prompt: ${JSON.stringify(detectorLine)}`;
      }
      header += ']';

      // Structured prompt info, when a library-specific parser matched.
      // Emitted on its own line so the LLM can parse it as JSON without
      // worrying about the surrounding status header format.
      const promptInfoLine = promptInfo
        ? `\n[prompt_info: ${JSON.stringify(promptInfo)}]`
        : '';

      // Terse next-step hints only for non-completed states.  Kept
      // short because the system prompt already explains semantics.
      const hint = buildNextStepHint(status);
      const body = output || '(no output captured)';
      const panePrefix = paneHeaderFor(ctx, pane);

      // For high-confidence password prompts, light up the wait card
      // RIGHT NOW (before the LLM has a chance to respond). The LLM's
      // wait_for_user_input call will adopt this card via consumeActivePreWait.
      // We only do this for `waiting_password` — y/n confirms and generic
      // input may legitimately be answered by type_text/press_keys, so we
      // don't want to flash a misleading "agent paused" UI for them.
      let preWaitNote = '';
      if (status === 'waiting_password') {
        startPreWait(pane.sessionId, waitAutoDetectedReason(detectorLine));
        preWaitNote =
          '\n[note: the agent UI is ALREADY showing a wait-for-user-input card for this prompt — the user can type now. You still MUST call wait_for_user_input to formally pause the agent loop; the tool will adopt the existing card rather than open a second one.]';
      }

      if (status === 'completed' && exitCode > 0) {
        return `${panePrefix}${header}${promptInfoLine}\n${body}${preWaitNote}`;
      }
      if (hint) {
        return `${panePrefix}${header}${promptInfoLine}\n${body}\n${hint}${preWaitNote}`;
      }
      return `${panePrefix}${header}${promptInfoLine}\n${body}${preWaitNote}`;
    },
  };
}

/** Terse next-step hint appended to run_command results for non-completed states. */
function buildNextStepHint(status: string): string {
  switch (status) {
    case 'waiting_password':
      return '[hint] The command is blocked on a PASSWORD prompt. '
        + 'You MUST call wait_for_user_input with a clear `reason` (e.g. "sudo password for apt install"). '
        + 'NEVER ask the user for the password in chat, and NEVER call type_text / press_keys here — both are refused on password prompts. '
        + 'wait_for_user_input will pause the agent, show a card prompting the user to type the password directly into the terminal, and auto-resume once the command completes.';
    case 'waiting_confirm':
      return '[hint] The command is waiting for a Y/n confirmation. If your intent is clear (install, proceed, overwrite, …), call type_text("y") followed by press_keys("Enter") (or "n"). If you are unsure, call wait_for_user_input so the user can decide in-terminal.';
    case 'waiting_input':
      return '[hint] The command is waiting for input. Call watch_terminal to see more context first. If the input is sensitive (API key, passphrase, token), use wait_for_user_input so the user types it directly — otherwise type_text the value and press_keys("Enter").';
    case 'tui':
      return '[hint] The terminal is in a full-screen TUI. To SEE what is on the screen, call read_screen — NEVER use read_terminal or watch_terminal for TUI inspection (they return cursor-positioning escapes that do not match what the user sees). To exit, use press_keys with the program-specific quit sequence (press_keys("q") for less/man/top/htop, press_keys("Esc") then type_text(":q") + press_keys("Enter") for vim, press_keys("Ctrl-C") to interrupt). After each exit attempt, INSPECT the [Terminal: ...] state line in the press_keys result — if it says "TUI just exited", STOP sending more exit keys. If you have made 2 exit attempts without success, call read_screen to verify the state, and consider web_search "how to quit <program>" for unfamiliar programs. Do NOT use wait_for_user_input here.';
    case 'idle_no_signal':
      return '[hint] The process is silent but may still be running. Call watch_terminal to observe, or read_terminal for a snapshot.';
    case 'timeout':
      return '[hint] The command exceeded its timeout. It may still be running. Use watch_terminal to observe, press_keys("Ctrl-C") to interrupt, or re-run with a longer timeout.';
    case 'aborted':
      return '[hint] Execution was aborted by the user.';
    default:
      return '';
  }
}

// ─── read_terminal ───────────────────────────────────────────────

export function createReadTerminalTool(): ToolHandler {
  return {
    definition: {
      name: 'read_terminal',
      description:
        'Read the most recent N lines from a pane\'s terminal screen buffer. Use ONLY to check terminal state before acting — NEVER after run_command (which already returns output). Pass `pane: <N>` to read a non-default pane (useful for correlating state across panes — e.g. check pane 2\'s logs while operating pane 1).',
      parameters: {
        type: 'object',
        properties: {
          lines: {
            type: 'number',
            description: 'Number of lines to read (default: 50)',
            default: 50,
          },
          pane: PANE_PARAM_SCHEMA,
        },
        required: [],
      },
    },
    // Read-only snapshot of the terminal buffer → safe to run in parallel.
    isConcurrencySafe: true,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const resolved = resolvePaneTarget(ctx, args.pane);
      if (!resolved.ok) return `Error: ${resolved.error}`;
      const pane = resolved.pane;
      const maxLines = (args.lines as number) || TOKEN_BUDGET.defaultTerminalLines;
      const buffer = TerminalRegistry.serializeBuffer(pane.sessionId);
      const prefix = paneHeaderFor(ctx, pane);
      if (!buffer) return `${prefix}(Terminal buffer is empty)`;

      const stripped = stripAnsi(buffer);
      const lines = stripped.split('\n');
      const recent = lines.slice(-maxLines);
      const content = recent.join('\n').trim();
      return `${prefix}${content || '(No output)'}`;
    },
  };
}

// ─── type_text ───────────────────────────────────────────────────
//
// Literal-text input. Sends `text` verbatim as UTF-8 bytes — no
// <Enter> parsing, no \n translation, no <...> token interpretation.
// Use whenever the LLM wants the program to "see exactly these
// characters" — answers, paths, code, Chinese, emoji, or anything
// containing literal `<` / `\` that a key-token parser would
// otherwise misinterpret.
//
// Pair with press_keys() when you also need a control key:
//   type_text("y") → press_keys("Enter")

export function createTypeTextTool(): ToolHandler {
  return {
    definition: {
      name: 'type_text',
      description:
        'Type literal text into the terminal. Sends the `text` argument verbatim as UTF-8 bytes — NO escape parsing, NO <Enter>/<Tab> tokens, NO backslash translation.\n' +
        '\n' +
        'Use this whenever you want the user/program to "see exactly these characters". Use press_keys() right after if you also need to press Enter or other keys.\n' +
        '\n' +
        'Common patterns:\n' +
        '  • Answer a prompt:        type_text("y") + press_keys("Enter")\n' +
        '  • Type Chinese:           type_text("你好,你是谁") + press_keys("Enter")\n' +
        '  • Search in vim:          type_text("/needle") + press_keys("Enter")\n' +
        '  • Type a file path:       type_text("/etc/hosts")\n' +
        '  • Snippet with angle:     type_text("if (x < 3) {")     ← angle brackets stay literal\n' +
        '  • Type a regex:           type_text("\\\\d+")              ← backslash stays literal\n' +
        '\n' +
        'Rules:\n' +
        '  • REFUSED on password prompts: use wait_for_user_input.\n' +
        '  • Empty string is rejected — pass a real value.\n' +
        '  • For Enter / Tab / arrows / Ctrl-C / etc., call press_keys() — type_text("\\n") types a literal backslash + n.\n' +
        '  • The send is one contiguous PTY write.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Literal text to type. Sent verbatim — no escape parsing.',
          },
          pane: PANE_PARAM_SCHEMA,
        },
        required: ['text'],
      },
    },
    isConcurrencySafe: false,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const text = args.text;
      if (typeof text !== 'string') {
        return 'Error: type_text requires a string "text" argument.';
      }
      if (text.length === 0) {
        return 'Error: type_text received an empty string. Pass a real value.';
      }

      const resolved = resolvePaneTarget(ctx, args.pane);
      if (!resolved.ok) return `Error: ${resolved.error}`;
      const pane = resolved.pane;

      const mt = TerminalRegistry.get(pane.sessionId);
      const connected = (mt?.transport && mt.transport.connected) || (mt?.ws && mt.ws.readyState === WebSocket.OPEN);
      if (!connected) {
        return `${paneHeaderFor(ctx, pane)}Error: terminal connection lost`;
      }

      const refusal = checkPasswordGate(pane.sessionId);
      if (refusal) return `${paneHeaderFor(ctx, pane)}${refusal}`;

      // Acquire the per-session PTY lock so we never interleave bytes
      // with another in-flight tool (run_command waiting for completion,
      // an SSH-routed read_file, etc.) targeting the same session.
      return await withSessionPtyLock(pane.sessionId, async () => {
        const wasAlt = isAlternateScreen(pane.sessionId);
        TerminalRegistry.sendInput(pane.sessionId, text);
        // Brief settle so the program can react (e.g. exit alt-screen
        // after `:q<Enter>` or enter alt-screen after `vim foo<Enter>`).
        // Without this we'd snapshot the BEFORE state.
        await sleep(80);
        const stateLine = formatTerminalStateLine(pane.sessionId, wasAlt);
        return `${paneHeaderFor(ctx, pane)}Typed: ${JSON.stringify(text)} → ${utf8ByteLen(text)} bytes\n${stateLine}`;
      });
    },
  };
}

// ─── press_keys ──────────────────────────────────────────────────
//
// Named-key keyboard input. Accepts ONLY named key tokens (and
// modifier combinations). Will NOT accept long literal strings —
// pass those through type_text instead.

export function createPressKeysTool(): ToolHandler {
  return {
    definition: {
      name: 'press_keys',
      description:
        'Press keyboard keys on the terminal. The bytes written are BYTE-FOR-BYTE the same data the kernel sees from a real keyboard — Enter is CR (0x0D), arrows are CSI sequences, Ctrl-C is 0x03, etc.\n' +
        '\n' +
        'This tool accepts ONLY named key tokens. To type literal characters call type_text() instead.\n' +
        '\n' +
        'Argument forms:\n' +
        '  • Single key:    press_keys({keys: "Enter"})\n' +
        '  • Array:         press_keys({keys: ["Down", "Down", "Enter"]})\n' +
        '  • Space-separated string: press_keys({keys: "Down Down Enter"})\n' +
        '\n' +
        'Known keys (case-insensitive):\n' +
        '  Enter Return CR LF Tab ShiftTab Esc Escape Space Backspace BS\n' +
        '  Delete Del Insert Ins\n' +
        '  Up Down Left Right Home End PageUp PgUp PageDown PgDn\n' +
        '  F1..F12\n' +
        '\n' +
        'Modifiers (combinable, any order):\n' +
        '  Ctrl-X / Control-X / C-x   — Ctrl + letter (0x01..0x1A)\n' +
        '  Alt-X / Meta-X / M-x       — Alt prepends ESC\n' +
        '  Shift-Tab                  — back-tab (CSI Z)\n' +
        '  Ctrl-Left / Ctrl-Right     — bash word-jump\n' +
        '  Alt-Backspace              — bash word-delete\n' +
        '\n' +
        'Examples:\n' +
        '  • Submit:               press_keys("Enter")\n' +
        '  • Cancel:               press_keys("Ctrl-C")\n' +
        '  • Quit less / man:      press_keys("q")\n' +
        '  • Vim quit:             type_text(":q") + press_keys("Enter")\n' +
        '  • Menu navigate:        press_keys(["Down", "Down", "Enter"])\n' +
        '  • fzf select 3rd:       press_keys("Down Down Enter")\n' +
        '  • Word back:            press_keys("Alt-B")\n' +
        '  • Tab complete:         press_keys("Tab")\n' +
        '  • Clear screen:         press_keys("Ctrl-L")\n' +
        '\n' +
        'Rules:\n' +
        '  • REFUSED on password prompts: use wait_for_user_input.\n' +
        '  • Unknown key tokens (e.g. "FooBar") return an error — use type_text for literal characters.\n' +
        '  • A single non-alphanumeric character (".", ",", "/", "q") is accepted as itself.\n' +
        '  • All keys in one call are sent as a contiguous burst.',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'string',
            description: 'One or more key tokens. Accepts a single name ("Enter"), a space-separated list ("Down Down Enter"), or a JSON array ("[\\"Down\\",\\"Down\\",\\"Enter\\"]"). Case-insensitive. Modifiers: Ctrl-, Alt-, Shift-.',
          },
          pane: PANE_PARAM_SCHEMA,
        },
        required: ['keys'],
      },
    },
    isConcurrencySafe: false,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const raw = args.keys;
      // Normalize input into a list of token strings.
      let tokens: string[];
      if (typeof raw === 'string') {
        tokens = raw.split(/\s+/).filter(Boolean);
      } else if (Array.isArray(raw)) {
        tokens = (raw as unknown[])
          .map((t) => (typeof t === 'string' ? t.trim() : ''))
          .filter(Boolean);
      } else {
        return 'Error: press_keys requires a "keys" argument (string or array of strings).';
      }
      if (tokens.length === 0) {
        return 'Error: press_keys received no key tokens. Pass at least one named key.';
      }

      const paneResolved = resolvePaneTarget(ctx, args.pane);
      if (!paneResolved.ok) return `Error: ${paneResolved.error}`;
      const pane = paneResolved.pane;

      const mt = TerminalRegistry.get(pane.sessionId);
      const connected = (mt?.transport && mt.transport.connected) || (mt?.ws && mt.ws.readyState === WebSocket.OPEN);
      if (!connected) {
        return `${paneHeaderFor(ctx, pane)}Error: terminal connection lost`;
      }

      const refusal = checkPasswordGate(pane.sessionId);
      if (refusal) return `${paneHeaderFor(ctx, pane)}${refusal}`;

      // Resolve every token. Unknown ones become an error so the
      // LLM knows to switch to type_text for literal characters.
      let bytes = '';
      const labels: string[] = [];
      for (const token of tokens) {
        const keyBytes = resolveSingleKey(token);
        if (keyBytes !== null) {
          bytes += keyBytes;
          labels.push(token);
          continue;
        }
        // Single non-angle-bracket character is allowed as a literal
        // convenience — useful for `press_keys("/")` when opening
        // vim search, or `press_keys("q")` to quit less.
        if (token.length === 1 && token !== '<' && token !== '>') {
          bytes += token;
          labels.push(token);
          continue;
        }
        return `${paneHeaderFor(ctx, pane)}Error: unknown key token "${token}". Known keys: Enter/Tab/Esc/Space/Backspace/Delete/Up/Down/Left/Right/Home/End/PageUp/PageDown/F1-F12 with optional Ctrl-/Alt-/Shift- modifiers. For literal characters use type_text() instead.`;
      }

      // Acquire the per-session PTY lock — see the type_text wrapper
      // for the rationale. Press_keys is just as racy as type_text
      // because both ultimately call TerminalRegistry.sendInput.
      return await withSessionPtyLock(pane.sessionId, async () => {
        const wasAlt = isAlternateScreen(pane.sessionId);
        TerminalRegistry.sendInput(pane.sessionId, bytes);
        // Brief settle so the program can react to the keys. Critical
        // for the "TUI just exited" case — vim writes \x1b[?1049l within
        // a few ms of receiving :q<Enter> and we want to catch the post
        // state.
        await sleep(80);
        const byteLen = utf8ByteLen(bytes);
        const ctrlCount = Array.from(bytes).filter(c => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f).length;
        const stateLine = formatTerminalStateLine(pane.sessionId, wasAlt);
        return `${paneHeaderFor(ctx, pane)}Pressed: [${labels.join(' ')}] → ${byteLen} bytes (${ctrlCount} control)\n${stateLine}`;
      });
    },
  };
}

// ─── watch_terminal ──────────────────────────────────────────────

export function createWatchTerminalTool(): ToolHandler {
  return {
    definition: {
      name: 'watch_terminal',
      description:
        'Observe terminal output live for a running command/process. Returns a structured [status: ...] header identical to run_command, plus the collected output.\n' +
        '\n' +
        'Returns when ANY of the following happens:\n' +
        '  0. The terminal is ALREADY in the state you asked about when the call arrives (the shell is back at its prompt, the awaited pattern is already on screen, or a password / Y-n prompt is already showing) → returns immediately, elapsed 0s, with the current screen as its body. No waiting.\n' +
        '  1. Shell returns to idle (command finished) → status: completed\n' +
        '  2. A password / Y-n / generic input prompt is detected → status: waiting_password / waiting_confirm / waiting_input\n' +
        '  3. The terminal enters a full-screen TUI → status: tui\n' +
        '  4. A caller-supplied regex pattern matches → status: pattern_matched\n' +
        '  5. No output for idle_timeout seconds → status: idle_no_signal\n' +
        '  6. Total observation deadline reached → status: timeout (process is NOT stopped)\n' +
        '  7. User stops the agent → status: aborted (process is NOT stopped)\n' +
        '\n' +
        'Typical use: after a run_command that returned idle_no_signal / timeout, or after you typed input via type_text / press_keys and want to observe the reaction.',
      parameters: {
        type: 'object',
        properties: {
          idle_timeout: {
            type: 'number',
            description: 'Seconds of silence (no output) before returning idle_no_signal. Resets on each new output. Default: 15',
          },
          pattern: {
            type: 'string',
            description: 'Optional regex pattern to match. Returns immediately when matched. Useful for waiting on specific prompts beyond the built-in detector.',
          },
          timeout: {
            type: 'number', minimum: 3, maximum: 300, default: 60,
            description: 'Total observation deadline in seconds (3–300, default 60). timeout ends observation only; it does not stop the process.',
          },
          pane: PANE_PARAM_SCHEMA,
        },
        required: [],
      },
    },
    // watch_terminal blocks the session on live output → not concurrent.
    isConcurrencySafe: false,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const paneResolved = resolvePaneTarget(ctx, args.pane);
      if (!paneResolved.ok) return `Error: ${paneResolved.error}`;
      const pane = paneResolved.pane;
      const panePrefix = paneHeaderFor(ctx, pane);

      const mt = TerminalRegistry.get(pane.sessionId);
      const connected = (mt?.transport && mt.transport.connected) || (mt?.ws && mt.ws.readyState === WebSocket.OPEN);
      if (!connected) {
        return `${panePrefix}Error: terminal connection lost`;
      }

      const idleTimeout = Math.max((args.idle_timeout as number) || 15, 3);
      const patternStr = args.pattern as string | undefined;
      let regex: RegExp | null = null;
      if (patternStr) {
        try {
          regex = new RegExp(patternStr, 'i');
        } catch {
          return `${panePrefix}Error: invalid regex pattern "${patternStr}"`;
        }
      }

      // ── Fast path: decide from state we can read RIGHT NOW ────────
      // Everything below this point waits for a future event, and none
      // of those events are replayed: onShellIdle is a broadcast rather
      // than a sticky flag, and onOutput only fires for bytes that have
      // not arrived yet. So when the command ALREADY finished, waiting
      // is guaranteed dead time — the old code burned the full
      // idle_timeout (15s by default) and then answered
      // `idle_no_signal` with an empty body, even though the finished
      // result was sitting on screen the whole time.
      const screenTail = tailOf(
        stripAnsi(TerminalRegistry.serializeBuffer(pane.sessionId) ?? '').replace(/\r/g, ''),
      );
      const tailIsPrompt = endsWithShellPrompt(screenTail);
      const hookInjected = !!mt.shellState.hookInjected;
      const phase = mt.shellState.phase ?? 'unknown';
      const screenBody = truncateOutput(screenTail.trim(), TOKEN_BUDGET.perToolOutputChars);

      // With the shell hook present, phase is authoritative and this
      // guard is unnecessary. Without it (SSH host without the hook,
      // PowerShell) a prompt-shaped tail is our only evidence — and it
      // is only evidence of a FINISHED command when nothing was typed
      // just now. Right after input the visible prompt is still the old
      // one, and the command it was typed for may not have started.
      const recentInput = userTypedRecently(mt.shellState.lastUserInputAt || 0, Date.now());
      const tailProvesIdle = shouldCompleteFromPromptTail({
        hookInjected,
        recentUserInput: recentInput,
        tailIsPrompt,
      });

      const pre = precheckWatch({ hookInjected, phase, tail: screenTail, pattern: regex, tailIsPrompt: tailProvesIdle });
      if (pre.kind === 'pattern_matched') {
        return `${panePrefix}[status: pattern_matched, elapsed: 0s, match: ${JSON.stringify(pre.match)}]`
          + `\n${screenBody || '(no output)'}`
          + '\n[note: returned immediately — the pattern was already present on screen before the watch began.]';
      }
      if (pre.kind === 'completed') {
        const fromHook = pre.source === 'shell-hook';
        const why = fromHook
          ? 'shell integration reports the prompt is up, so no foreground command owns the terminal'
          : 'the visible tail is a shell prompt and no shell-integration hook is available';
        // A screen-derived completion carries no exit status: with no
        // hook, lastExitCode was never written and is stuck at 0.
        const exit = fromHook ? exitCodeFromHook(pane.sessionId) : EXIT_CODE_UNKNOWN;
        const exitNote = fromHook ? '' : ', exit code unavailable (no shell hook)';
        return `${panePrefix}[status: completed, elapsed: 0s, exit: ${exit}]`
          + `\n${screenBody || '(no output)'}`
          + `\n[note: returned immediately — ${why}${exitNote}. The body above is the CURRENT screen, not a live capture.]`;
      }

      // The screen may already be blocked on a password / Y-n prompt.
      // Those states are authoritative whenever they appeared, so a
      // watcher that never receives another byte must not report
      // idle_no_signal. Only skipped when the hook has authoritatively
      // certified the prompt above — `phase` says nothing on a hookless
      // session (see ShellPhase), so it must not be used alone here.
      if (!hookInjected || phase !== 'ready') {
        const existing = detectInteractiveState(tailOf(screenTail, WATCH_DETECT_TAIL_CHARS), false);
        if (existing.state === 'waiting_password' || existing.state === 'waiting_confirm') {
          const infoLine = existing.promptInfo
            ? `\n[prompt_info: ${JSON.stringify(existing.promptInfo)}]`
            : '';
          return `${panePrefix}[status: ${existing.state}, elapsed: 0s, prompt: ${JSON.stringify(existing.matchedLine)}]`
            + `${infoLine}\n${screenBody || '(no output)'}\n${buildNextStepHint(existing.state)}`;
        }
      }

      type FinishReason =
        | 'aborted'
        | 'timeout'
        | 'pattern_matched'
        | 'completed'
        | 'idle_no_signal'
        | 'waiting_password'
        | 'waiting_confirm'
        | 'waiting_input'
        | 'tui';

      // Baseline alt-screen state — treat a transition false→true
      // as "a TUI just started". If the session is already inside
      // tmux/screen, baselineAlt === true and we never report 'tui'.
      let baselineAlt = false;
      try {
        baselineAlt = mt.terminal.buffer.active.type === 'alternate';
      } catch { /* ignore */ }

      // Acquire the per-session PTY lock for the entire watch window.
      // While we're observing this session, no other tool may inject
      // input or kick off another command on the same PTY — that would
      // race with the running command we're waiting on and corrupt
      // both its output and our view of it. Different sessions remain
      // free to run in parallel.
      return withSessionPtyLock(pane.sessionId, () => new Promise<string>((resolve) => {
        let resolved = false;
        let matchedLine = '';
        let idleTimer: ReturnType<typeof setTimeout>;
        let detectorTimer: ReturnType<typeof setInterval>;
        const startTime = Date.now();
        /** Timestamp of the last byte we appended (idle/detector pacing). */
        let lastOutputAt = Date.now();
        /** Did ANY new output arrive during this watch window? */
        let hadOutput = false;
        /** Has the detector already run for the current quiet period? */
        let detectorChecked = false;

        const cleanup = () => {
          resolved = true;
          unsubOutput();
          unsubIdle();
          clearTimeout(idleTimer);
          clearInterval(detectorTimer);
          lifecycle.dispose();
        };

        const finalize = (
          reason: FinishReason,
          extra?: string,
          promptInfo?: import('./ai-tools-prompt-detect').PromptInfo,
        ) => {
          if (resolved) return;
          cleanup();
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const stripped = stripAnsi(lifecycle.output).trim();
          const truncated = truncateOutput(stripped, TOKEN_BUDGET.perToolOutputChars);

          let header = `[status: ${reason}, elapsed: ${elapsed}s`;
          if (reason === 'completed') {
            // `completed` is reached either from the shell hook or from
            // the hookless prompt-settle path; only the former can know
            // an exit status (see exitCodeFromHook).
            header += `, exit: ${exitCodeFromHook(pane.sessionId)}`;
          } else if (reason === 'pattern_matched' && matchedLine) {
            header += `, match: ${JSON.stringify(matchedLine)}`;
          } else if (extra) {
            header += `, prompt: ${JSON.stringify(extra)}`;
          }
          header += ']';
          const promptInfoLine = promptInfo
            ? `\n[prompt_info: ${JSON.stringify(promptInfo)}]`
            : '';
          const omitted = lifecycle.wasTruncated ? '\n[Earlier output omitted; retained latest 65536 characters]' : '';
          // No new bytes arrived, but the screen may still hold exactly
          // what the caller is after — answering "(no output)" for a
          // terminal that is visibly full of text tells the model
          // nothing and forces an extra read_terminal round-trip.
          const body = truncated
            || (screenBody
              ? `${screenBody}\n[note: no new output during the watch window — showing the current screen.]`
              : '(no output)');
          resolve(`${panePrefix}${header}${promptInfoLine}${omitted}\n${body}`);
        };
        const lifecycle = createWatchLifecycle(ctx.abortSignal, watchTimeoutSeconds(args.timeout) * 1000, finalize);

        // Reset idle timer — called on each new output
        const resetIdleTimer = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => finalize('idle_no_signal'), idleTimeout * 1000);
        };

        // Start initial idle timer
        resetIdleTimer();

        // Periodic detector check: alt-screen transition + prompt patterns
        detectorTimer = setInterval(() => {
          if (resolved) return;
          // Only report 'tui' if alt-screen flipped on *during* this
          // watch. Sessions already in tmux have baselineAlt=true.
          try {
            const nowAlt = mt.terminal.buffer.active.type === 'alternate';
            if (!baselineAlt && nowAlt) {
              finalize('tui');
              return;
            }
          } catch { /* ignore */ }

          const silentMs = Date.now() - lastOutputAt;
          if (silentMs < WATCH_DETECT_SILENCE_MS) {
            // Still streaming: a detector run now would read a
            // half-written line and could fire on a partial prompt.
            // Re-arm so the next quiet period gets one fresh check.
            detectorChecked = false;
            return;
          }
          // Hookless completion. Without OSC 7768 (SSH into a host where
          // the hook could not be injected, PowerShell, failed injection)
          // no shell-idle event will ever arrive, so a quiet prompt tail
          // is the best "the command finished" evidence available. This
          // is the same last-resort rule run_command already applies.
          // Keep checking until the longer prompt-settle interval passes;
          // the interactive detector below may have run at 1200ms already.
          if (!hookInjected && hadOutput && silentMs >= WATCH_PROMPT_SETTLE_MS
            && endsWithShellPrompt(lifecycle.output)) {
            finalize('completed');
            return;
          }

          // One interactive check per quiet period — the old loop
          // re-scanned the entire (up to 64 KB) buffer every 400ms.
          if (detectorChecked) return;
          detectorChecked = true;

          const det = detectInteractiveState(lifecycle.output, false);
          if (det.state === 'waiting_password' || det.state === 'waiting_confirm' || det.state === 'waiting_input') {
            finalize(det.state, det.matchedLine, det.promptInfo);
          }
        }, 400);

        // Subscribe to output stream
        const unsubOutput = TerminalRegistry.onOutput(pane.sessionId, (data) => {
          if (resolved) return;
          lifecycle.append(data);
          hadOutput = true;
          lastOutputAt = Date.now();
          resetIdleTimer(); // output received → reset idle countdown

          // Check caller-supplied pattern first — it wins over detector.
          // Scanned across the whole tail (not just the last 5 lines) so
          // a banner that arrived a few lines above the cursor still
          // matches.
          if (regex) {
            const match = lastMatchingLine(tailOf(stripAnsi(lifecycle.output)), regex);
            if (match) {
              matchedLine = match;
              finalize('pattern_matched');
              return;
            }
          }
        });

        // Subscribe to shell idle (command finished)
        const unsubIdle = TerminalRegistry.onShellIdle(pane.sessionId, () => {
          finalize('completed');
        });
        lifecycle.start();
      }));
    },
  };
}

// ─── wait_for_user_input ─────────────────────────────────────────
//
// This is the SAFE path for handling interactive credential prompts
// (sudo password, ssh passphrase, GPG, mysql, dpkg etc.). The agent
// pauses itself here; a UI card tells the user to type into the
// terminal; the tool returns when the shell goes idle again.
//
// Security contract:
//   • We never read what the user typed — bytes go directly from
//     xterm.js to the backend PTY via the normal input path.
//   • The tool's return value never contains the user's keystrokes;
//     it reports only "completed" / "timeout" / "cancelled".
//   • The conversation history is never polluted with secrets.

export function createWaitForUserInputTool(): ToolHandler {
  return {
    definition: {
      name: 'wait_for_user_input',
      description:
        'Pause the agent and wait for the USER to type something directly in the terminal (sudo/SSH/GPG password, host-key confirmation, TUI input, etc.).\n' +
        '\n' +
        '== CRITICAL SECURITY RULE ==\n' +
        'Whenever a command is blocked on a password prompt, YOU MUST call this tool. NEVER ask the user for a password in the chat — passwords must go directly from the user\'s keyboard to the terminal so they stay out of the conversation history and model context.\n' +
        '\n' +
        'What this tool does:\n' +
        '  • Shows a highlighted "Agent paused — waiting for you" card in the UI\n' +
        '  • Sends a desktop notification if the window is in the background\n' +
        '  • Blocks until the shell returns to its prompt (command finished) OR the caller-specified timeout elapses OR the user cancels\n' +
        '  • Does NOT read what the user typed\n' +
        '\n' +
        'Returns a [status: ...] header:\n' +
        '  [status: completed, exit: N]   — shell is back at its prompt, the agent should inspect terminal state and continue\n' +
        '  [status: timeout]              — user did not respond within the timeout, agent should stop and ask for help in plain text\n' +
        '  [status: aborted]              — the user cancelled the wait',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Short human-readable reason shown to the user in the waiting card. E.g. "sudo password for apt install", "SSH host key confirmation for new server", "GPG passphrase for signing".',
          },
          timeout: {
            type: 'number',
            description: 'Maximum seconds to wait before giving up. Default: 300 (5 minutes). Clamped to [30, 1800].',
            default: 300,
          },
        },
        required: ['reason'],
      },
    },
    // Serializes the agent loop by design — never concurrent.
    isConcurrencySafe: false,
    // Already safe (read-only wait); never needs confirmation or is destructive.
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const reason = String(args.reason || 'User input required').slice(0, 200);
      const timeoutSec = Math.min(
        Math.max((args.timeout as number) || 300, 30),
        1800,
      );

      const mt = TerminalRegistry.get(ctx.sessionId);
      if (!mt) return 'Error: terminal session not found';
      const connected = (mt.transport && mt.transport.connected) || (mt.ws && mt.ws.readyState === WebSocket.OPEN);
      if (!connected) {
        return 'Error: terminal connection lost';
      }

      // Adopt the still-active pre-emptive wait card if run_command
      // already started one. Adoption skips the start dispatch so the
      // user doesn't see a duplicate card flash.
      const adopted = consumeActivePreWait(ctx.sessionId);

      // Race fast-path: by the time we got here the shell may already
      // be back at its prompt — the user typed fast, the command
      // finished, and the busy→idle transition that powers shell-idle
      // already fired before we could register a listener. Phase is
      // the source of truth for this; checking it avoids the trap of
      // attaching a listener that will never fire (and hanging until
      // the configured timeout).
      //
      // Phase only ever reaches 'ready' via the OSC 7768 hook, so on a
      // hookless session (SSH without hook injection) that check alone
      // is not enough — the same race also has to be recognized from
      // the visible prompt, otherwise the tool blocks until timeout.
      //
      // We do NOT short-circuit when we just adopted a pre-wait —
      // those cases are funneled through the pre-wait's own
      // dispatchEnd, which has already happened before consumeActivePreWait
      // could find it. So if adopted is non-null, the wait is still
      // in flight by definition.
      // `phase === 'ready'` is only ever written by the hook, so the hook
      // flag must gate it as well — a hookless session has no exit code to
      // report and must fall back to the visible-prompt check.
      const hookAtPrompt = mt.shellState.hookInjected && mt.shellState.phase === 'ready';
      if (!adopted && (hookAtPrompt || isShellPromptVisible(ctx.sessionId))) {
        // phase === 'ready' only ever comes from the hook; the prompt
        // check can also succeed on a hookless session, where no exit
        // code exists to report.
        const fromHook = hookAtPrompt;
        const exit = fromHook ? exitCodeFromHook(ctx.sessionId) : EXIT_CODE_UNKNOWN;
        return (
          `[status: completed, elapsed: 0s, exit: ${exit}]\n`
          + `The shell is already at its prompt — the underlying command finished `
          + `before this tool call arrived (likely because the user typed the input `
          + `before the agent caught up).`
          + (fromHook ? '' : ' No shell hook on this session, so no exit code is available.')
          + ` Inspect the terminal (read_terminal) if `
          + `you need the command's output.`
        );
      }

      const cardId = adopted?.cardId ?? `wait-${Date.now().toString(36)}`;
      if (!adopted) {
        document.dispatchEvent(new CustomEvent('ai-wait-for-user-input-start', {
          detail: { sessionId: ctx.sessionId, cardId, reason, timeoutSec },
        }));
      } else {
        // Upgrade the pre-emptive card's text to the LLM's richer
        // reason — "sudo password for apt install foo" reads way
        // better than the generic "Auto-detected password prompt".
        // Also refresh the timeout-bearing hint if it differs.
        document.dispatchEvent(new CustomEvent('ai-wait-for-user-input-reason-updated', {
          detail: { cardId, reason, timeoutSec },
        }));
      }

      const startedAt = Date.now();

      // Snapshot the last-user-input timestamp BEFORE we start. If the
      // user typed in the terminal just before the agent realised it
      // needed to wait (LLM round-trip delay between detecting a
      // password prompt and calling this tool), we'd otherwise show a
      // misleading "waiting for you" card after they already typed.
      const inputBaseline = mt.shellState.lastUserInputAt || 0;

      return new Promise<string>((resolve) => {
        let resolved = false;
        let receivedFired = false;
        let unsubIdle: (() => void) | null = null;
        let unsubInput: (() => void) | null = null;
        let unsubCancel: (() => void) | null = null;
        let promptWatch: PromptReturnWatch | null = null;
        let onAbort: (() => void) | null = null;
        let deadline: ReturnType<typeof setTimeout> | null = null;

        const dispatchEnd = (status: string) => {
          try {
            document.dispatchEvent(new CustomEvent('ai-wait-for-user-input-end', {
              detail: { cardId, status },
            }));
          } catch { /* ignore */ }
        };

        const dispatchReceived = () => {
          if (receivedFired) return;
          receivedFired = true;
          try {
            document.dispatchEvent(new CustomEvent('ai-wait-for-user-input-received', {
              detail: { cardId },
            }));
          } catch { /* ignore */ }
        };

        const cleanup = () => {
          if (resolved) return;
          resolved = true;
          if (unsubIdle) unsubIdle();
          if (unsubInput) unsubInput();
          if (unsubCancel) unsubCancel();
          if (promptWatch) promptWatch.cancel();
          if (deadline) clearTimeout(deadline);
          if (onAbort && ctx.abortSignal) {
            ctx.abortSignal.removeEventListener('abort', onAbort);
          }
        };

        // Real-time signal: the user has typed SOMETHING in the
        // terminal. Flips the card from "waiting" to "received, command
        // still running" so the user gets immediate feedback that the
        // agent saw their input. We don't resolve here — the agent
        // still waits for shell-idle so it doesn't continue mid-command.
        unsubInput = TerminalRegistry.onInput(ctx.sessionId, () => {
          if (resolved || receivedFired) return;
          dispatchReceived();
        });

        // Handle the "user typed just before the tool got called" race:
        // the agent's LLM round-trip can add 1-2s of latency between
        // detecting a password prompt and reaching this point, during
        // which a fast user may have already typed. The lastUserInputAt
        // timestamp covers that gap.
        if (mt.shellState.lastUserInputAt > inputBaseline) {
          dispatchReceived();
        }

        // User clicks "Cancel" in the waiting card — this is the
        // intended escape hatch if they decide to stop the task.
        const onCancel = (e: Event) => {
          const ev = e as CustomEvent<{ cardId: string }>;
          if (ev.detail?.cardId !== cardId) return;
          cleanup();
          dispatchEnd('aborted');
          resolve(`[status: aborted, elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s]\nUser cancelled the wait. Stop and ask the user in plain text what to do next.`);
        };
        document.addEventListener('ai-wait-for-user-input-cancel', onCancel);
        unsubCancel = () => document.removeEventListener('ai-wait-for-user-input-cancel', onCancel);

        // External abort signal from the owning ToolAgent — e.g. the
        // user pressed Escape / clicked the stop button at the top
        // level, or closed the chat panel. Unblock immediately.
        if (ctx.abortSignal) {
          if (ctx.abortSignal.aborted) {
            // Already aborted before we even started listening.
            cleanup();
            dispatchEnd('aborted');
            resolve(`[status: aborted, elapsed: 0s]\nRun aborted before user could respond.`);
            return;
          }
          onAbort = () => {
            if (resolved) return;
            cleanup();
            dispatchEnd('aborted');
            resolve(`[status: aborted, elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s]\nRun aborted by the user.`);
          };
          ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
        }

        // Hard timeout.
        deadline = setTimeout(() => {
          if (resolved) return;
          cleanup();
          dispatchEnd('timeout');
          resolve(`[status: timeout, elapsed: ${timeoutSec}s]\nUser did not complete the input within the timeout. Stop and ask the user in plain text whether they need more time or want to abort the operation.`);
        }, timeoutSec * 1000);

        // Primary signal: shell returned to its prompt (OSC 7768).
        // This fires ONCE the user has typed the credential + Enter
        // and the underlying command (sudo/ssh/gpg) finished.
        unsubIdle = TerminalRegistry.onShellIdle(ctx.sessionId, () => {
          if (resolved) return;
          cleanup();
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          // The hook wrote lastExitCode just before firing this event.
          const exit = exitCodeFromHook(ctx.sessionId);
          dispatchEnd('completed');
          resolve(
            `[status: completed, elapsed: ${elapsed}s, exit: ${exit}]\n`
            + `User input complete; the shell has returned to its prompt. `
            + `Inspect the terminal (read_terminal) if you need to see the result of the command that was waiting.`,
          );
        });

        // Fallback signal for sessions WITHOUT the shell hook — the
        // hook is what emits OSC 7768, and on SSH it must be injected
        // (settings-dependent, and the single injection attempt can
        // fail before the remote shell is ready). Without this the
        // exact case this tool exists for — sudo asking for a password
        // — left the agent blocked on an idle signal that never came,
        // long after the user had typed and the command had finished.
        // The user-input guard keeps a prompt that was already on
        // screen from completing the wait prematurely.
        promptWatch = watchForPromptReturn(ctx.sessionId, () => receivedFired, () => {
          if (resolved) return;
          cleanup();
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          // Detected from the screen, not from the hook: there is no
          // exit status to report (and lastExitCode would be stale).
          const exit = exitCodeFromHook(ctx.sessionId);
          dispatchEnd('completed');
          resolve(
            `[status: completed, elapsed: ${elapsed}s, exit: ${exit}]\n`
            + `The shell is back at its prompt after the user's input (detected from the `
            + `terminal output — this session has no shell hook, so no exit code is available). `
            + `Inspect the terminal (read_terminal) if you need to see what the command that was waiting printed.`,
          );
        });
      });
    },
  };
}

// ─── read_screen ─────────────────────────────────────────────────
//
// Captures a PNG snapshot of the live terminal and attaches it to
// the tool result as an image. Useful when the text buffer alone
// isn't enough (TUI programs, mouse menus, ncurses dialogs, etc.).

export function createReadScreenTool(): ToolHandler {
  return {
    definition: {
      name: 'read_screen',
      description:
        'Capture a PNG screenshot of the current terminal display and attach it to the tool result as an image part — YOU will receive the actual image and should look at it directly.\n' +
        '\n' +
        'WHY THIS TOOL EXISTS:\n' +
        'TUI programs (vim, htop, less, tmux, ncurses dialogs, top, btop, k9s, lazygit, fzf …) draw their UI using cursor positioning, box-drawing characters, color attributes, and the alternate screen buffer. The plain text serialization that read_terminal returns is often INCOMPLETE or AMBIGUOUS for these programs:\n' +
        '  • Box-drawing characters look like garbage\n' +
        '  • Selected/highlighted rows are indistinguishable from normal rows (color is lost)\n' +
        '  • Status bars / mode indicators may be missing\n' +
        '  • Cursor position cannot be inferred\n' +
        '\n' +
        'WHEN TO CALL THIS TOOL:\n' +
        '  • The previous run_command returned [status: tui]\n' +
        '  • You need to know what is highlighted / selected / focused in a TUI menu\n' +
        '  • read_terminal returned text that does not match what the user is asking about\n' +
        '  • You launched a full-screen program (vim, less, htop, fzf …) and need to react to it\n' +
        '\n' +
        'HOW THE RESULT IS DELIVERED:\n' +
        'You will receive a multimodal tool result containing (a) a short text header noting size + capture method, and (b) the actual PNG bytes as an image part. Look at the image directly — do NOT ask the user to OCR it for you, do NOT try to decode it from text, and do NOT call run_command to "see" it. The text header is informational only; the visual content is in the image part.\n' +
        '\n' +
        'PREFER read_terminal when you only need plain text — it is much cheaper. Use read_screen specifically when visual rendering matters.',
      parameters: {
        type: 'object',
        properties: {
          pane: PANE_PARAM_SCHEMA,
        },
        required: [],
      },
    },
    // Read-only snapshot → safe for parallel execution.
    isConcurrencySafe: true,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<ToolOutputWithImages> {
      const paneResolved = resolvePaneTarget(ctx, args.pane);
      if (!paneResolved.ok) {
        return { text: `Error: ${paneResolved.error}`, images: [] };
      }
      const pane = paneResolved.pane;
      const panePrefix = paneHeaderFor(ctx, pane);
      const shot = await captureTerminalScreen(pane.sessionId);
      if (!shot) {
        return {
          text: `${panePrefix}[read_screen: failed to capture terminal — session not found or empty buffer]`,
          images: [],
        };
      }
      return {
        text: `${panePrefix}[read_screen: ${shot.width}x${shot.height} PNG, method=${shot.method}]`,
        images: [
          {
            mediaType: 'image/png',
            data: shot.data,
            label: `pane${pane.paneNumber}-${Date.now()}.png`,
          },
        ],
      };
    },
  };
}
