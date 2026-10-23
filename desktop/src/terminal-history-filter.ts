// Which lines typed into a terminal may become command history.
//
// Without a shell hook the AI Bar records whatever was typed before Enter,
// which also caught passwords typed at sudo/ssh/mysql prompts and every line
// typed inside vim, less or a REPL. Pure module so it runs under `node --test`.

/** A prompt asking for something secret, ending in a colon (input is usually hidden). */
const SECRET_PROMPT = /(pass(word|phrase|code)?|\bpin\b|\botp\b|token|secret|verification code|密码|口令|验证码)[^\n]*[:：]\s*$/i;

/**
 * @param typed       the line typed before Enter
 * @param cursorLine  the terminal row the cursor is on when Enter is pressed
 * @param altScreen   whether a full-screen program (vim, less, top) owns the screen
 */
export function shouldRecordTypedLine(typed: string, cursorLine: string, altScreen: boolean): boolean {
  if (!typed.trim() || altScreen) return false;
  // Shell convention (HISTCONTROL=ignorespace, zsh HIST_IGNORE_SPACE): a
  // leading space keeps a command out of history.
  if (/^\s/.test(typed)) return false;
  const row = cursorLine.trimEnd();
  // What is left of the row once the echoed input is taken off is the prompt.
  const prompt = row.endsWith(typed.trimEnd()) ? row.slice(0, row.length - typed.trimEnd().length) : row;
  return !SECRET_PROMPT.test(prompt);
}
