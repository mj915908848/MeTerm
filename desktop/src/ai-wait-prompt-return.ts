// ─── AI Agent: "the shell prompt came back" fallback ─────────────
//
// The OSC 7768 shell-idle signal is the authoritative "the foreground
// command finished" signal — but it only exists when the shell hook is
// actually installed.  On an SSH session it comes from the injection
// performed by injectShellHook(), which is skipped when
// `shellHookInjection` is off, and can also fail silently (the one
// allowed attempt is spent before the remote shell is ready).
//
// `run_command` already copes with that: its wait loop falls back to
// "the buffer tail looks like a shell prompt after a beat of silence"
// (ai-tools-shell.ts step b').  The two WAIT CARDS did not, so the
// exact scenario the feature exists for — the user types a sudo
// password into the terminal — ended with the agent blocked on shell
// idle that never arrives: the card sat at "已收到你的输入，等待命令
// 执行完成" and the capsule stayed on 工作中 until the timeout.
//
// This module gives both wait paths the same fallback.
//
// Deliberately NOT used for detection: `detectInteractiveState()` on
// the whole scrollback.  After a sudo run the tail still contains the
// "[sudo] password for …" line, which makes that detector report
// `waiting_password` again; `endsWithShellPrompt()` only looks at the
// last non-empty line and rejects it when it carries a prompt keyword,
// which is the check we want here.

import { TerminalRegistry } from './terminal';
import { endsWithShellPrompt } from './ai-tools-prompt-detect';

/**
 * How long the session must stay silent before a visible shell prompt
 * counts as "the command finished".  Slightly tighter than the 1.5s
 * run_command uses because a wait card is already blocking the user.
 */
export const PROMPT_RETURN_SILENCE_MS = 1200;

/** Poll cadence — mirrors run_command's 300ms tick. */
const POLL_MS = 300;

/**
 * Grace period after arming.  A wait card is usually created while the
 * password prompt is still on screen, but the model can also call
 * wait_for_user_input a moment *after* the command finished; this keeps
 * the first tick from firing on a prompt that was already there.
 */
const MIN_ARM_MS = 400;

export interface PromptReturnWatch {
  /** Stop watching without invoking the callback. */
  cancel(): void;
}

/**
 * Is the session currently sitting at an idle shell prompt?
 *
 * Synchronous one-shot check, used as the fast path when a wait tool
 * arrives after the command already finished (the busy→idle transition
 * already happened, so a fresh idle listener would never fire).
 */
export function isShellPromptVisible(sessionId: string): boolean {
  const buffer = TerminalRegistry.serializeBuffer(sessionId);
  if (!buffer) return false;
  return endsWithShellPrompt(buffer);
}

/**
 * Watch a session for "the command that the user was answering finished
 * and the shell is back at its prompt" without relying on the shell hook.
 *
 * @param sessionId    PTY session to watch.
 * @param hasUserInput Evaluated on every tick; the caller decides what
 *                     counts as "the user has typed something" (the wait
 *                     cards flip this on their first terminal input).
 *                     Only consulted when the terminal was ALREADY
 *                     showing a prompt when the watch was armed — a
 *                     prompt that merely appears later is itself the
 *                     signal, and demanding a keystroke on top of it
 *                     would re-introduce a way to hang.
 * @param onReturn     Called once, when the prompt is back.
 * @param silenceMs    Silence window; defaults to PROMPT_RETURN_SILENCE_MS.
 */
export function watchForPromptReturn(
  sessionId: string,
  hasUserInput: () => boolean,
  onReturn: () => void,
  silenceMs: number = PROMPT_RETURN_SILENCE_MS,
): PromptReturnWatch {
  const armedAt = Date.now();
  // If a prompt is already up when we arm, that prompt belongs to the
  // command BEFORE the one we are waiting on — ignoring it is the whole
  // point of the guard below.
  const promptVisibleAtArm = isShellPromptVisible(sessionId);
  let lastOutputAt = Date.now();
  let stopped = false;

  const unsubOutput = TerminalRegistry.onOutput(sessionId, () => {
    lastOutputAt = Date.now();
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    unsubOutput();
  };

  const timer = setInterval(() => {
    if (stopped) return;
    const now = Date.now();
    if (now - armedAt < MIN_ARM_MS) return;
    if (now - lastOutputAt < silenceMs) return;
    if (promptVisibleAtArm && !hasUserInput()) return;
    if (!isShellPromptVisible(sessionId)) return;
    stop();
    onReturn();
  }, POLL_MS);

  return { cancel: stop };
}
