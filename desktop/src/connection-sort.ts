/** Persisted display-only ordering, independent of connection metadata. */
export const GROUP_SORT_KEY = 'meterm-connection-group-sort';
export const CONNECTION_SORT_MODES = ['default', 'ip-asc', 'ip-desc', 'name-asc', 'name-desc'] as const;
export type ConnectionSortMode = typeof CONNECTION_SORT_MODES[number];
export interface SortableConnection { name: string; host: string; port: number }

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
  return Object.prototype.hasOwnProperty.call(sorts, group) ? sorts[group] : 'default';
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

function ipv4(host: string): number[] | null {
  const parts = host.split('.');
  return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
    ? parts.map(Number) : null;
}
export function sortConnections<T>(
  items: readonly T[], mode: ConnectionSortMode, language: string,
  address: (item: T) => SortableConnection,
): T[] {
  const copy = [...items];
  if (mode === 'default') return copy;
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: 'base' });
  const direction = mode.endsWith('-desc') ? -1 : 1;
  return copy.sort((a, b) => {
    const left = address(a), right = address(b);
    if (mode.startsWith('name-')) return direction * collator.compare(left.name, right.name);
    const l4 = ipv4(left.host), r4 = ipv4(right.host);
    let hostOrder = 0;
    if (l4 && r4) {
      for (let i = 0; i < 4 && !hostOrder; i++) hostOrder = l4[i] - r4[i];
    } else {
      hostOrder = collator.compare(left.host, right.host);
    }
    return direction * (hostOrder || left.port - right.port || collator.compare(left.name, right.name));
  });
}
