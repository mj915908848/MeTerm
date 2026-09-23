import { migrateGroupSort } from './connection-sort';

/**
 * Connection group management — stores group assignments in localStorage.
 *
 * Each connection (SSH / Remote / JumpServer) can belong to one group.
 * Groups are identified by a user-defined name string.
 * Connections not assigned to any group are treated as "ungrouped".
 */

const GROUPS_KEY = 'meterm-connection-groups';
const GROUP_ORDER_KEY = 'meterm-connection-group-order';
const GROUP_COLORS_KEY = 'meterm-connection-group-colors';
const GROUP_COLLAPSED_KEY = 'meterm-connection-group-collapsed';

export interface ConnectionGroupMap {
  /** key = "<type>:<identifier>", value = group name */
  [connectionKey: string]: string;
}

// ─── Group order (user-defined ordering of groups) ───

export function loadGroupOrder(): string[] {
  try {
    const raw = localStorage.getItem(GROUP_ORDER_KEY);
    if (raw) {
      const parsed: string[] = JSON.parse(raw);
      // Filter out any __type:* entries that may have been saved erroneously.
      // New ones can no longer be created — see `isReservedGroupName` — but a
      // store written before that existed may still hold them.
      return parsed.filter(name => !name.startsWith('__type:'));
    }
  } catch {}
  return [];
}

export function saveGroupOrder(order: string[]): void {
  localStorage.setItem(GROUP_ORDER_KEY, JSON.stringify(order));
}

/**
 * Names the app owns rather than the user.
 *
 * Every internal id in this feature lives in the `__` namespace:
 * `__ungrouped__` is the sentinel bucket for connections that belong to no group
 * (used by `home-side.ts`, `connection-drag.ts` and `connection-sort.ts`), and
 * `__type:<kind>` is the dashboard's id for the per-kind cards it draws out of
 * that same bucket (`home-dashboard-left.ts`), which `loadGroupOrder` filters
 * back out.
 *
 * Both sentinels are compared **by value**, so a user group that takes one is
 * not merely odd-looking — it is unreachable:
 *
 *   - a group named `__type:ssh` is dropped by `loadGroupOrder`, so it never
 *     gets a dashboard card and its connections disappear from the dashboard;
 *   - a group named `__ungrouped__` is indistinguishable from "no group", so its
 *     rows merge into the root bucket and the group itself never appears.
 *
 * Neither failure reports anything when it happens: the name is accepted, the
 * group is written, and the damage only surfaces later as rows in the wrong
 * place. Hence a hard "no" at the two places a name can be chosen.
 *
 * Names already in storage are deliberately *not* migrated: renaming or
 * unassigning a user's connections to tidy up a sentinel would be a real data
 * loss, where leaving a merely-odd group is not. `loadGroupOrder` already
 * tolerates the `__type:*` leftovers it used to accept.
 */
const RESERVED_GROUP_PREFIX = '__';

/** Is this one of the app's own names rather than one a user may own? */
export function isReservedGroupName(name: string): boolean {
  return name.startsWith(RESERVED_GROUP_PREFIX);
}

// ─── Connection → Group mapping ───

export function loadGroupMap(): ConnectionGroupMap {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

export function saveGroupMap(map: ConnectionGroupMap): void {
  localStorage.setItem(GROUPS_KEY, JSON.stringify(map));
}

// ─── Key helpers ───

export function sshKey(name: string): string {
  return `ssh:${name}`;
}

export function remoteKey(host: string, port: number): string {
  return `remote:${host}:${port}`;
}

export function jumpserverKey(name: string): string {
  return `jumpserver:${name}`;
}

// ─── CRUD operations ───

export function setConnectionGroup(connectionKey: string, groupName: string): void {
  const map = loadGroupMap();
  map[connectionKey] = groupName;
  saveGroupMap(map);
  // Ensure the group exists in order list
  const order = loadGroupOrder();
  if (!order.includes(groupName)) {
    order.push(groupName);
    saveGroupOrder(order);
  }
}

export function removeConnectionGroup(connectionKey: string): void {
  const map = loadGroupMap();
  delete map[connectionKey];
  saveGroupMap(map);
}

/**
 * Move several connections in one write. `groupName` of `null` ungroups them.
 *
 * The per-key setters re-read and re-write the whole map on every call, which is
 * fine for one row and wrong for a multi-row drag: the list would re-render
 * halfway through the batch, and a failure between two writes would leave the
 * user with half the selection moved. One read, one write.
 */
export function assignConnectionsToGroup(
  connectionKeys: readonly string[],
  groupName: string | null,
): void {
  if (connectionKeys.length === 0) return;
  const map = loadGroupMap();
  for (const key of connectionKeys) {
    if (groupName) map[key] = groupName;
    else delete map[key];
  }
  saveGroupMap(map);
  // Ensure the destination exists in the order list, so a group that only ever
  // received dragged rows still renders in a stable position.
  if (groupName) {
    const order = loadGroupOrder();
    if (!order.includes(groupName)) {
      order.push(groupName);
      saveGroupOrder(order);
    }
  }
}

export function getConnectionGroup(connectionKey: string): string | undefined {
  return loadGroupMap()[connectionKey];
}

// ─── Group management ───

/**
 * Create a group. Returns false — writing nothing — for a reserved name: see
 * `isReservedGroupName`. The callers that matter validate first so the user gets
 * a message; this is the backstop that stops a programmatic caller from quietly
 * creating a group the rest of the app cannot address.
 */
export function createGroup(name: string): boolean {
  if (isReservedGroupName(name)) return false;
  const order = loadGroupOrder();
  if (!order.includes(name)) {
    order.push(name);
    saveGroupOrder(order);
  }
  return true;
}

/**
 * Rename a group. Returns false for a reserved name.
 *
 * The refused case is not cosmetic: the rename would re-point every connection
 * of the group at a name the app reads as one of its own sentinels, which is a
 * data-loss shape (the rows become unaddressable) rather than a bad label.
 */
export function renameGroup(oldName: string, newName: string): boolean {
  if (oldName === newName) return true;
  if (isReservedGroupName(newName)) return false;
  migrateGroupSort(oldName, newName);
  // Update order
  const order = loadGroupOrder();
  const idx = order.indexOf(oldName);
  if (idx >= 0) order[idx] = newName;
  else order.push(newName);
  saveGroupOrder(order);
  // Update all connection mappings
  const map = loadGroupMap();
  for (const key of Object.keys(map)) {
    if (map[key] === oldName) map[key] = newName;
  }
  saveGroupMap(map);
  return true;
}

export function deleteGroup(name: string): void {
  migrateGroupSort(name);
  // Remove from order
  const order = loadGroupOrder().filter((g) => g !== name);
  saveGroupOrder(order);
  // Unassign all connections in this group
  const map = loadGroupMap();
  for (const key of Object.keys(map)) {
    if (map[key] === name) delete map[key];
  }
  saveGroupMap(map);
}

export function listGroups(): string[] {
  return loadGroupOrder();
}

/** Returns group names that actually have connections assigned + the count per group */
export function getGroupCounts(): Map<string, number> {
  const map = loadGroupMap();
  const counts = new Map<string, number>();
  for (const group of Object.values(map)) {
    counts.set(group, (counts.get(group) || 0) + 1);
  }
  return counts;
}

// ─── Group colors ───

export function loadGroupColors(): Record<string, string> {
  try {
    const raw = localStorage.getItem(GROUP_COLORS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

export function setGroupColor(groupName: string, color: string): void {
  const colors = loadGroupColors();
  colors[groupName] = color;
  localStorage.setItem(GROUP_COLORS_KEY, JSON.stringify(colors));
}

export function removeGroupColor(groupName: string): void {
  const colors = loadGroupColors();
  delete colors[groupName];
  localStorage.setItem(GROUP_COLORS_KEY, JSON.stringify(colors));
}

// ─── Group collapsed state ───

export function loadGroupCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(GROUP_COLLAPSED_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

export function toggleGroupCollapsed(groupName: string): boolean {
  const collapsed = loadGroupCollapsed();
  const isNowCollapsed = !collapsed.has(groupName);
  if (isNowCollapsed) collapsed.add(groupName);
  else collapsed.delete(groupName);
  localStorage.setItem(GROUP_COLLAPSED_KEY, JSON.stringify([...collapsed]));
  return isNowCollapsed;
}

// ─── Group duplication ───

export function duplicateGroup(groupName: string): string {
  const order = loadGroupOrder();
  let newName = groupName + ' (Copy)';
  let n = 2;
  while (order.includes(newName)) { newName = `${groupName} (Copy ${n++})`; }
  // Insert after original in order
  const idx = order.indexOf(groupName);
  order.splice(idx + 1, 0, newName);
  saveGroupOrder(order);
  // Copy color
  const colors = loadGroupColors();
  if (colors[groupName]) {
    colors[newName] = colors[groupName];
    localStorage.setItem(GROUP_COLORS_KEY, JSON.stringify(colors));
  }
  return newName;
}

// ─── JumpServer Asset Connection History ───

const JS_ASSET_HISTORY_KEY = 'meterm-js-asset-history';

export interface JSAssetHistoryEntry {
  /** JumpServer config name */
  serverName: string;
  /** Asset ID */
  assetId: string;
  /** Asset display name */
  assetName: string;
  /** Asset IP/hostname */
  assetAddress: string;
  /** Account username used */
  accountUsername: string;
  /** Account ID */
  accountId: string;
  /** Number of times connected */
  count: number;
  /** Last connected timestamp (ms) */
  lastUsed: number;
}

export function loadJSAssetHistory(): JSAssetHistoryEntry[] {
  try {
    const raw = localStorage.getItem(JS_ASSET_HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveJSAssetHistory(entries: JSAssetHistoryEntry[]): void {
  localStorage.setItem(JS_ASSET_HISTORY_KEY, JSON.stringify(entries));
}

/** Record a JumpServer asset connection. Call this when connectToAsset succeeds. */
export function recordJSAssetConnection(
  serverName: string,
  assetId: string,
  assetName: string,
  assetAddress: string,
  accountUsername: string,
  accountId: string,
): void {
  const entries = loadJSAssetHistory();
  const key = `${serverName}:${assetId}:${accountUsername}`;
  const existing = entries.find(
    (e) => `${e.serverName}:${e.assetId}:${e.accountUsername}` === key,
  );
  if (existing) {
    existing.count++;
    existing.lastUsed = Date.now();
    existing.assetName = assetName;
    existing.assetAddress = assetAddress;
    existing.accountId = accountId;
  } else {
    entries.push({
      serverName, assetId, assetName, assetAddress,
      accountUsername, accountId, count: 1, lastUsed: Date.now(),
    });
  }
  saveJSAssetHistory(entries);
}

/** Get JumpServer asset history sorted by frequency (most used first) */
export function getJSAssetHistoryByFrequency(serverName?: string): JSAssetHistoryEntry[] {
  let entries = loadJSAssetHistory();
  if (serverName) entries = entries.filter((e) => e.serverName === serverName);
  return entries.sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed);
}

/** Remove a specific asset history entry */
export function removeJSAssetHistory(serverName: string, assetId: string, accountUsername: string): void {
  const entries = loadJSAssetHistory().filter(
    (e) => !(e.serverName === serverName && e.assetId === assetId && e.accountUsername === accountUsername),
  );
  saveJSAssetHistory(entries);
}
