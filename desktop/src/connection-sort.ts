/** Persisted display-only ordering, independent of connection metadata. */
export const GROUP_SORT_KEY = 'meterm-connection-group-sort';
export const CONNECTION_SORT_KEYS = ['name', 'added'] as const;
export type ConnectionSortKey = typeof CONNECTION_SORT_KEYS[number];
export const CONNECTION_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type ConnectionSortDirection = typeof CONNECTION_SORT_DIRECTIONS[number];
export type ConnectionSortMode = `${ConnectionSortKey}-${ConnectionSortDirection}`;
export const CONNECTION_SORT_MODES: readonly ConnectionSortMode[] = ['added-asc', 'added-desc', 'name-asc', 'name-desc'];
/** Oldest first: the order connections were saved in, which was the old "default". */
export const DEFAULT_CONNECTION_SORT: ConnectionSortMode = 'added-asc';
/**
 * `addedAt` is the save time in ms. Connections saved before it existed have
 * none; they count as older than every stamped one and keep their saved order.
 */
export interface SortableConnection { name: string; addedAt?: number }

export function sortModeKey(mode: ConnectionSortMode): ConnectionSortKey {
  return mode.startsWith('name-') ? 'name' : 'added';
}
export function sortModeDirection(mode: ConnectionSortMode): ConnectionSortDirection {
  return mode.endsWith('-desc') ? 'desc' : 'asc';
}

export function readGroupSorts(): Record<string, ConnectionSortMode> {
  try {
    const parsed = JSON.parse(localStorage.getItem(GROUP_SORT_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, mode]) =>
      CONNECTION_SORT_MODES.includes(mode as ConnectionSortMode))) as Record<string, ConnectionSortMode>;
  } catch { return {}; }
}
export function getGroupSort(group: string): ConnectionSortMode {
  const sorts = readGroupSorts();
  return Object.prototype.hasOwnProperty.call(sorts, group) ? sorts[group] : DEFAULT_CONNECTION_SORT;
}
export function setGroupSort(group: string, mode: ConnectionSortMode): void {
  const sorts = readGroupSorts();
  Object.defineProperty(sorts, group, { value: mode, enumerable: true, configurable: true, writable: true });
  localStorage.setItem(GROUP_SORT_KEY, JSON.stringify(sorts));
}
export function migrateGroupSort(oldName: string, newName?: string): void {
  const sorts = readGroupSorts();
  const mode = Object.prototype.hasOwnProperty.call(sorts, oldName) ? sorts[oldName] : undefined;
  delete sorts[oldName];
  if (newName !== undefined && mode) Object.defineProperty(sorts, newName, {
    value: mode, enumerable: true, configurable: true, writable: true,
  });
  localStorage.setItem(GROUP_SORT_KEY, JSON.stringify(sorts));
}

export function sortConnections<T>(
  items: readonly T[], mode: ConnectionSortMode, language: string,
  fields: (item: T) => SortableConnection,
): T[] {
  // Ascending with the saved order as the last tie-break, then reversed for
  // descending, so equal names and unstamped entries flip with the rest.
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: 'base' });
  const rows = items.map((item, index) => ({ item, index, f: fields(item) }));
  rows.sort((a, b) => (sortModeKey(mode) === 'name'
    ? collator.compare(a.f.name, b.f.name)
    : (a.f.addedAt ?? 0) - (b.f.addedAt ?? 0)) || a.index - b.index);
  if (sortModeDirection(mode) === 'desc') rows.reverse();
  return rows.map(row => row.item);
}

/**
 * Sort scope of the "no group" bucket. The connection list keys that bucket by
 * `UNGROUPED` in home-side.ts and the home page's per-type cards show exactly
 * those rows, so the two names have to stay identical — `sort-sync.test.mts`
 * fails if either drifts.
 */
export const UNGROUPED_GROUP = '__ungrouped__';

/** Name and save time of a stored SSH or JumpServer connection. */
export function connectionSortFields(item: { name: string; raw: unknown }): SortableConnection {
  const addedAt = (item.raw as { addedAt?: unknown } | null | undefined)?.addedAt;
  return { name: item.name, addedAt: typeof addedAt === 'number' && Number.isFinite(addedAt) ? addedAt : undefined };
}

/**
 * Sort one group's rows the way the connection manager renders them.
 *
 * Every surface that lists connections inside a group has to go through this —
 * the home page's cards and the connection window both show the same bucket, and
 * a surface that skips it silently falls back to insertion order, which reads as
 * "the sort I picked over there did nothing here".
 *
 * `group === null` addresses the ungrouped bucket.
 */
export function sortGroupConnections<T extends { name: string; raw: unknown }>(
  items: readonly T[], group: string | null, language: string,
): T[] {
  return sortConnections(items, getGroupSort(group ?? UNGROUPED_GROUP), language, connectionSortFields);
}
