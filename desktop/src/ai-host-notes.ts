// ─── AI Agent: host notes ──────────────────────────────────────
// Short notes kept per host — where a service lives, how it is
// deployed, what to watch out for — that the agent sees again the next
// time it works on that host. The agent adds to them with the
// save_host_note tool (shown on an approval card); the user can read,
// edit and delete them in Settings › AI.
//
// Keyed by host:port without the user name: the notes describe the
// machine, whoever logs in. Local panes share the key "local". Stored in
// localStorage, which every MeTerm window shares. Import-free (apart
// from localStorage) so node tests can load it.

const STORAGE_KEY = 'meterm-host-notes';
/** Longest note text kept per host. */
export const HOST_NOTES_MAX_CHARS = 4000;
export const LOCAL_HOST_KEY = 'local';

export interface HostNotesEntry {
  notes: string;
  updatedAt: number;
}

/** Notes key for a pane: "host:port" for SSH ("user@" dropped), else "local". */
export function hostNotesKey(isSSH: boolean, serverInfo: string | null | undefined): string | null {
  if (!isSSH) return LOCAL_HOST_KEY;
  const target = (serverInfo ?? '').trim();
  if (!target) return null;
  const at = target.lastIndexOf('@');
  return (at >= 0 ? target.slice(at + 1) : target).toLowerCase() || null;
}

function readAll(): Record<string, HostNotesEntry> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, HostNotesEntry> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<HostNotesEntry> | null;
      if (entry && typeof entry.notes === 'string' && entry.notes.trim()) {
        out[key] = { notes: entry.notes, updatedAt: Number(entry.updatedAt) || 0 };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, HostNotesEntry>): void {
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(all));
  if (typeof window !== 'undefined' && typeof Event === 'function') {
    window.dispatchEvent(new Event('meterm-host-notes-changed'));
  }
}

export function getHostNotes(key: string): string {
  return readAll()[key]?.notes ?? '';
}

/** Notes plus last-change time; null when the host has none. */
export function getHostNotesEntry(key: string): HostNotesEntry | null {
  return readAll()[key] ?? null;
}

export const HOST_NOTES_STORAGE_KEY = STORAGE_KEY;
/** Fired on window after a save in this window (other windows get `storage`). */
export const HOST_NOTES_CHANGED_EVENT = 'meterm-host-notes-changed';

/** Every host with notes, most recently changed first. */
export function listHostNotes(): Array<{ key: string } & HostNotesEntry> {
  return Object.entries(readAll())
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Replace a host's notes; empty text deletes them. Throws when too long. */
export function setHostNotes(key: string, notes: string, now = Date.now()): void {
  const text = notes.replace(/\r\n/g, '\n').trim();
  if (text.length > HOST_NOTES_MAX_CHARS) {
    throw new Error(`notes are ${text.length} characters; the limit is ${HOST_NOTES_MAX_CHARS}`);
  }
  const all = readAll();
  if (text) all[key] = { notes: text, updatedAt: now };
  else delete all[key];
  writeAll(all);
}

/** One "- " bullet per non-empty line of `text`. */
export function toBullets(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^[-*•]\s*/, ''))
    .filter(Boolean)
    .map((line) => `- ${line}`);
}

/** The notes after adding each line of `note` as its own bullet (not saved). */
export function appendedHostNotes(current: string, note: string): string {
  return [current.trim(), ...toBullets(note)].filter(Boolean).join('\n');
}
