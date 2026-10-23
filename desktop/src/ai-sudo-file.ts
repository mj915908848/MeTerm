// ─── AI Tools: root-owned files on SSH sessions ─────────────────
// read_file / write_file / edit_file with `sudo: true`. SFTP runs as the
// login user, so files under /etc and friends cannot be changed over it.
// Instead of falling back to `sudo sed -i` (which the user cannot review),
// the file is staged through a private temp file:
//
//   1. `sudo cat path > $(mktemp)`        (shell, prints the temp path)
//   2. read / edit / overwrite the temp    (SFTP, as the login user)
//   3. `sudo tee path < temp`, `rm temp`   (shell)
//
// `tee` rewrites the target in place, so it keeps its owner and mode.
// Every sudo call uses `-n`: a password prompt is never typed through
// here. When sudo needs a password the tool says so, and the agent asks
// the user to run `sudo -v` in the terminal first.
//
// The scripts run under `sh -c` with the paths as positional arguments,
// so they work the same from bash, zsh or fish, and nothing is left in
// the user's shell variables.
//
// Import-free so node tests can load it: callers pass the target path
// already quoted for the remote shell (quoteRemotePath).

const TEMP_MARK = 'MTMP:';
const DONE_MARK = 'MTDONE';

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function shScript(script: string, args: string[]): string {
  return `sh -c ${shQuote(script)} sh ${args.join(' ')}`;
}

/** Copy `path` (read as root) into a new temp file; prints the temp path. */
export function sudoStageCommand(quotedPath: string): string {
  return shScript(
    `t=$(mktemp) || exit 1; if sudo -n cat -- "$1" > "$t"; then printf '${TEMP_MARK}%s\\n' "$t"; else rm -f -- "$t"; exit 1; fi`,
    [quotedPath],
  );
}

/** Create an empty temp file; prints its path. */
export function tempFileCommand(): string {
  return shScript(`t=$(mktemp) || exit 1; printf '${TEMP_MARK}%s\\n' "$t"`, []);
}

/** Write the temp file's bytes over `path` as root, then remove the temp. */
export function sudoCommitCommand(quotedPath: string, temp: string, mkdirs: boolean): string {
  const mkdir = mkdirs ? `sudo -n mkdir -p -- "$(dirname -- "$1")" && ` : '';
  return shScript(
    `${mkdir}sudo -n tee -- "$1" < "$2" > /dev/null; r=$?; rm -f -- "$2"; [ $r -eq 0 ] && printf 'MT%s\\n' DONE`,
    [quotedPath, shQuote(temp)],
  );
}

export function removeTempCommand(temp: string): string {
  return `rm -f -- ${shQuote(temp)}`;
}

/** The temp path printed by a stage / temp command, or null on failure. */
export function parseTempPath(output: string): string | null {
  const m = /MTMP:(\/\S+)/.exec(output);
  return m ? m[1] : null;
}

/** The marker is printed as `MT` + `DONE`, so the echoed command never contains it. */
export function commitSucceeded(output: string): boolean {
  return output.includes(DONE_MARK);
}

/** Turn the shell output of a failed step into a message for the model. */
export function describeSudoFailure(output: string): string {
  if (/password is required|a terminal is required|askpass/i.test(output)) {
    return 'sudo needs a password on this host. Ask the user to authenticate first: run_command `sudo -v`, then call wait_for_user_input so they can type the password in the terminal. After that, retry this call.';
  }
  if (/not in the sudoers|not allowed to run|may not run sudo/i.test(output)) {
    return 'the login user is not allowed to use sudo on this host.';
  }
  if (/command not found|sudo: not found/i.test(output)) {
    return 'sudo is not installed on this host.';
  }
  const last = output.trim().split('\n').filter(Boolean).slice(-3).join('\n');
  return last || 'the command failed without output.';
}
