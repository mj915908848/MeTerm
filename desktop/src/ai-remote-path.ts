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
