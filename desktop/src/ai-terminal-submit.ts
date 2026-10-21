// ─── AI Agent: Terminal Submit Classification ──────────────
//
// type_text / press_keys write raw bytes into the PTY. At a shell
// prompt, a CR / LF in those bytes submits the current line, which is
// exactly what run_command does — so it has to go through the same
// danger heuristic and permission rules. This module works out which
// command lines a type_text / press_keys call would submit, given what
// is already on the shell's input line.
//
// Pure: callers read the live line from the terminal and pass it in.

import { resolveSingleKey } from './ai-tools-keys.ts';

/** What is on the shell input line before the call. `null` = unknown. */
export type InputLine = string | null;

export type TerminalSubmit =
  /** The call cannot submit a line at a shell prompt. */
  | { kind: 'none' }
  /** The call submits these exact lines. */
  | { kind: 'commands'; lines: string[] }
  /** The call submits a line whose content cannot be determined. */
  | { kind: 'unknown'; lines: string[] };

export interface SubmitClassification {
  submit: TerminalSubmit;
  /** Input line after the call; `null` when it cannot be tracked. */
  nextLine: InputLine;
}

// CR / LF submit; Ctrl-O (bash operate-and-get-next) also executes.
const SUBMIT_BYTES = new Set(['\r', '\n', '\x0f']);
// Ctrl-C / Ctrl-U clear the line without running it.
const CLEAR_BYTES = new Set(['\x03', '\x15']);
const BACKSPACE_BYTES = new Set(['\x7f', '\b']);

/** Split press_keys' `keys` argument into byte chunks, one per token. */
export function pressKeysChunks(raw: unknown): string[] | null {
  let tokens: string[];
  if (typeof raw === 'string') {
    tokens = raw.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(raw)) {
    tokens = raw.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
  } else {
    return null;
  }
  const chunks: string[] = [];
  for (const token of tokens) {
    const bytes = resolveSingleKey(token);
    if (bytes !== null) chunks.push(bytes);
    else if (token.length === 1 && token !== '<' && token !== '>') chunks.push(token);
    else return null; // the tool rejects unknown tokens before writing anything
  }
  return chunks;
}

/**
 * Replay `chunks` against the shell's line editor. Printable text is
 * appended; anything that moves the cursor or recalls history (arrows,
 * Tab, Ctrl-R, Esc…) makes the line unknown from then on.
 */
function replay(chunks: string[], line: InputLine, keyChunks: boolean): SubmitClassification {
  const lines: string[] = [];
  let unknown = false;
  let current = line;
  for (const chunk of chunks) {
    const isKeySequence = keyChunks && chunk.length > 1 && /^[\x00-\x1f\x7f]/.test(chunk);
    if (isKeySequence) {
      // Multi-byte key (arrow, F-key, Alt-x…): cannot model, but it may
      // still carry a submit byte (Alt-Enter = ESC CR).
      if ([...chunk].some((c) => SUBMIT_BYTES.has(c))) {
        unknown = true;
        lines.push(current ?? '');
      }
      current = null;
      continue;
    }
    for (const ch of chunk) {
      if (SUBMIT_BYTES.has(ch)) {
        if (current === null) unknown = true;
        lines.push(current ?? '');
        current = '';
      } else if (CLEAR_BYTES.has(ch)) {
        current = '';
      } else if (BACKSPACE_BYTES.has(ch)) {
        if (current !== null) current = Array.from(current).slice(0, -1).join('');
      } else if (ch.charCodeAt(0) < 0x20) {
        current = null;
      } else if (current !== null) {
        current += ch;
      }
    }
  }
  const visible = lines.map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { submit: { kind: 'none' }, nextLine: current };
  return {
    submit: unknown ? { kind: 'unknown', lines: visible } : { kind: 'commands', lines: visible },
    nextLine: current,
  };
}

/**
 * Classify a type_text / press_keys call made while the terminal sits
 * at a shell prompt whose input line is `line`.
 */
export function classifyTerminalInput(
  toolName: string,
  args: Record<string, unknown>,
  line: InputLine,
): SubmitClassification {
  if (toolName === 'type_text') {
    if (typeof args.text !== 'string') return { submit: { kind: 'none' }, nextLine: line };
    return replay([args.text], line, false);
  }
  if (toolName === 'press_keys') {
    const chunks = pressKeysChunks(args.keys);
    if (!chunks) return { submit: { kind: 'none' }, nextLine: line };
    return replay(chunks, line, true);
  }
  return { submit: { kind: 'none' }, nextLine: line };
}
