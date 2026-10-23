// ─── AI Agent: environment facts ───────────────────────────────
// Small, import-free helpers that describe a pane's environment for the
// system prompt (OS, shell, date), so the agent does not spend its first
// steps on `uname` / `cat /etc/os-release` / `date`. Kept import-free so
// node tests can load it; the session-scoped cache lives in
// ai-host-facts.ts.

/** PRETTY_NAME (or NAME VERSION_ID) from an /etc/os-release body. */
export function parseOsRelease(text: string): string | null {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields.set(m[1], value.replace(/\\(["'\\$`])/g, '$1'));
  }
  const pretty = fields.get('PRETTY_NAME')?.trim();
  if (pretty) return pretty.slice(0, 80);
  const name = fields.get('NAME')?.trim();
  if (!name) return null;
  const version = fields.get('VERSION_ID')?.trim();
  return (version ? `${name} ${version}` : name).slice(0, 80);
}

/** OS of the machine MeTerm itself runs on, from the user agent. */
export function localOsFromUserAgent(ua: string): string {
  const lower = ua.toLowerCase();
  if (lower.includes('windows')) return 'Windows';
  if (lower.includes('macintosh') || lower.includes('mac os')) return 'macOS';
  if (lower.includes('linux')) return 'Linux';
  return '';
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "2026-10-23 (Friday)" in the user's local time. */
export function localDateStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} (${WEEKDAYS[now.getDay()]})`;
}
