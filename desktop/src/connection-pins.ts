/**
 * connection-pins.ts — which saved connections are favourites (the star).
 *
 * Kept apart from the list renderer so the home page's start content and the
 * quick switcher can read favourites without importing the list.
 */
const PIN_KEY = 'meterm-pinned-connections';

export function loadPinned(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function isPinned(key: string): boolean {
  return loadPinned().has(key);
}

export function togglePin(key: string): void {
  const s = loadPinned();
  if (s.has(key)) s.delete(key);
  else s.add(key);
  localStorage.setItem(PIN_KEY, JSON.stringify([...s]));
}
