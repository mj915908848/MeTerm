// ─── Last command block ─────────────────────────────────────────
// With the shell hook in place every prompt arrives as an OSC 7768 event
// carrying the command that just finished and its exit code. Marking the
// prompt row each time lets the AI context include the user's last
// command together with ALL of its output, instead of a fixed number of
// lines from the bottom of the screen that may start in the middle of an
// error.
//
// xterm markers follow their row as scrollback is trimmed, and report
// line -1 once the row is gone.

import type { IMarker } from '@xterm/xterm';
import type { ManagedTerminal } from './terminal-types';

interface CommandBlock {
  command: string;
  exitCode: number;
  /** Sent by the AI agent (run_command), not typed by the user. */
  byAgent: boolean;
  /** Row of the prompt the command was typed at. */
  start: IMarker;
  /** Row of the prompt that followed it. */
  end: IMarker;
}

interface BlockState {
  prompt?: IMarker;
  block?: CommandBlock;
}

const states = new WeakMap<ManagedTerminal, BlockState>();

/**
 * Record a prompt reported by the shell hook. Runs after the output
 * written before the event has been parsed, so the cursor sits on the
 * new prompt.
 */
export function recordPrompt(mt: ManagedTerminal, command: string, exitCode: number, byAgent: boolean): void {
  mt.terminal.write('', () => {
    const state = states.get(mt) ?? {};
    const prev = state.prompt;
    const now = mt.terminal.registerMarker(0);
    if (!now) return;
    const old = state.block;
    let block = old;
    const cmd = command.trim();
    // The hook reports an empty command when nothing ran (empty Enter, Ctrl-C).
    if (cmd && prev && prev.line >= 0) {
      block = { command: cmd, exitCode, byAgent, start: prev, end: now };
    }
    const keep = new Set<IMarker>([now, ...(block ? [block.start, block.end] : [])]);
    for (const m of [prev, old?.start, old?.end]) {
      if (m && !keep.has(m)) m.dispose();
    }
    states.set(mt, { prompt: now, block });
  });
}

/**
 * Where user input begins. OSC 7768 arrives before the shell prints its prompt,
 * and xterm parses output asynchronously, so the cursor at the event is still
 * at the start of the prompt: reading the input line from there picked up the
 * prompt text. So this runs as a write callback, after the event and after each
 * output write while the prompt is open, and the last call before input arrives
 * leaves the cursor at the end of the prompt (the last row of a two-line one).
 */
export function trackPromptEnd(mt: ManagedTerminal): void {
  if (!mt.shellState.promptOpen) return;
  const buffer = mt.terminal.buffer.active;
  mt.shellState.promptRow = buffer.baseY + buffer.cursorY;
  mt.shellState.promptCol = buffer.cursorX;
}

/** Text of one buffer row plus any rows soft-wrapped onto it. */
function logicalLines(mt: ManagedTerminal, from: number, to: number): string[] {
  const buffer = mt.terminal.buffer.active;
  const out: string[] = [];
  for (let row = from; row < to; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
    else out.push(text);
  }
  return out;
}

/**
 * The last finished command and its output, or null when there is none
 * or the screen has moved on since (a command still running, `clear`,
 * the rows scrolled out of the buffer).
 */
export function lastCommandBlock(
  mt: ManagedTerminal,
): { command: string; exitCode: number; byAgent: boolean; output: string } | null {
  const state = states.get(mt);
  const block = state?.block;
  if (!block || state.prompt !== block.end) return null;
  if (block.start.line < 0 || block.end.line < 0 || block.end.line <= block.start.line) return null;
  const buffer = mt.terminal.buffer.active;
  // Output below the last prompt means something is running that the
  // hook has not reported yet; the plain tail describes that better.
  if (buffer.baseY + buffer.cursorY - block.end.line > 2) return null;
  // First logical line is the prompt with the command typed after it.
  const lines = logicalLines(mt, block.start.line, block.end.line).slice(1);
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  return { command: block.command, exitCode: block.exitCode, byAgent: block.byAgent, output: lines.join('\n') };
}
