// ─── Host notes: display names ─────────────────────────────────
// Notes are keyed by host:port; people know their servers by the names
// they gave the saved connections. This maps a key back to those names
// for the notes editor and the settings list.

import { loadSavedConnections } from './ssh';
import { LOCAL_HOST_KEY } from './ai-host-notes';
import { t } from './i18n';

/** Saved connection names pointing at `key` ("host:port"), deduplicated. */
export function connectionNamesFor(key: string): string[] {
  if (key === LOCAL_HOST_KEY) return [];
  const names = loadSavedConnections()
    .filter((c) => `${c.host}:${c.port}`.toLowerCase() === key)
    .map((c) => c.name.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/** Title + subtitle for a notes key: connection name(s) over host:port. */
export function hostNotesTitle(key: string): { title: string; subtitle: string } {
  if (key === LOCAL_HOST_KEY) return { title: t('aiHostNotesLocal'), subtitle: '' };
  const names = connectionNamesFor(key);
  return names.length > 0 ? { title: names.join(' / '), subtitle: key } : { title: key, subtitle: '' };
}

/** "2026-10-23 13:28" in local time. */
export function formatNotesTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
