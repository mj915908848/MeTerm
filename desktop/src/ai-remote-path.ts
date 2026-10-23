// ─── Remote path quoting ───────────────────────────────────────
// read_file / write_file on SSH sessions build a shell command around the
// path. Kept import-free so node tests can load it.

/**
 * Quote a path for the remote shell. Single quotes keep `$`, backticks and
 * globs inert, but they also stop `~` from expanding — and the tools promise
 * `~/`-prefixed paths. So a leading `~` / `~/` becomes `"$HOME"` outside the
 * quotes. A relative path starting with `-` gets `./` so no command reads it
 * as an option.
 */
export function quoteRemotePath(path: string): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  if (path === '~') return '"$HOME"';
  if (path.startsWith('~/')) return `"$HOME"${quote(path.slice(1))}`;
  if (path.startsWith('-')) return quote(`./${path}`);
  return quote(path);
}

/**
 * Turn a tool path into one the SFTP client accepts. SFTP resolves
 * relative paths against the login directory (normally $HOME), so `~/x`
 * becomes `x`; other relative paths are joined to the pane's cwd. Returns
 * null when SFTP cannot express the path (`~user/…`, or a relative path
 * with no known absolute cwd) — callers fall back to the shell.
 */
export function resolveSftpPath(path: string, cwd: string): string | null {
  const value = path.trim();
  if (!value) return null;
  if (value === '~') return '.';
  if (value.startsWith('~/')) return value.slice(2) || '.';
  if (value.startsWith('~')) return null;
  if (value.startsWith('/')) return value;
  const base = cwd.trim();
  if (!base.startsWith('/')) return null;
  return `${base.replace(/\/+$/, '')}/${value}`;
}
