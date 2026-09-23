/**
 * Home Dashboard — Left panel: connection buttons, recent activity,
 * connection groups, context menus, group modals, drag reorder.
 * Extracted from home-dashboard.ts for code size control.
 */
import { settings } from './app-state';
import { t } from './i18n';
import { icon } from './icons';
import { showToast } from './notify';
import { createOverlayScrollbar } from './overlay-scrollbar';
import { appendSshConnectionMenuItems } from './development-credential-recovery-ui';
import { loadCardOrder, saveCardOrder } from './home-dashboard-card-order';
import {
  clearCardWidth,
  dragCardWidth,
  loadCardWidths,
  setCardWidth,
} from './home-card-width';
import { sortGroupConnections } from './connection-sort';
import {
  type SSHConnectionConfig,
  loadSavedConnections,
  loadRecentConnections,
  removeRecentConnection,
  showSSHModal,
  removeConnection as removeSSHConnection,
  getSSHConnectHandler,
} from './ssh';
import {
  type RemoteServerInfo,
  loadSavedRemoteConnections,
  loadRecentRemoteConnections,
  removeRecentRemoteConnection,
  showRemoteEditDialog,
  showRemoteCardSessionPopup,
  removeRemoteConnection,
} from './remote';
import {
  type JumpServerConfig,
  loadJumpServerConfigs,
  removeJumpServerConfig,
} from './jumpserver-api';
import {
  loadGroupMap,
  loadGroupOrder,
  visibleGroupName,
  sshKey,
  remoteKey,
  jumpserverKey,
  createGroup,
  renameGroup,
  isReservedGroupName,
  deleteGroup,
  assignConnectionsToGroup,
  removeConnectionGroup,
  loadGroupColors,
  setGroupColor,
  removeGroupColor,
  loadGroupCollapsed,
  toggleGroupCollapsed,
  duplicateGroup,
  type ConnectionGroupMap,
  getJSAssetHistoryByFrequency,
  type JSAssetHistoryEntry,
} from './connection-groups';

// ─── Types ───

export interface ConnectionItem {
  type: 'ssh' | 'remote' | 'jumpserver';
  key: string;
  name: string;
  detail: string;
  raw: SSHConnectionConfig | RemoteServerInfo | JumpServerConfig;
}

const GROUP_COLORS = ['#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#78716c'];

// ─── Collect & filter ───

export function collectAllConnections(): ConnectionItem[] {
  const items: ConnectionItem[] = [];
  for (const c of loadSavedConnections()) {
    items.push({ type: 'ssh', key: sshKey(c.name), name: c.name || c.host, detail: `${c.username}@${c.host}:${c.port}`, raw: c });
  }
  for (const r of loadSavedRemoteConnections()) {
    items.push({ type: 'remote', key: remoteKey(r.host, r.port), name: r.name || r.host, detail: `${r.host}:${r.port}`, raw: r });
  }
  for (const j of loadJumpServerConfigs()) {
    items.push({ type: 'jumpserver', key: jumpserverKey(j.name), name: j.name, detail: `${j.username}@${j.sshHost}:${j.sshPort}`, raw: j });
  }
  return items;
}

export function filterConnections(items: ConnectionItem[], query: string): ConnectionItem[] {
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter((i) => i.name.toLowerCase().includes(q) || i.detail.toLowerCase().includes(q));
}

// ─── Recent connections (home view) ───

/**
 * Render the servers this device actually connected to, most recent first, as
 * the horizontal card track the full-page home used to show.
 *
 * A compact card per entry (icon + name + user@host, × to forget it) laid out
 * left to right and scrolled sideways — a wide window shows several at once
 * instead of one tall column. Newest entries come from the SSH/remote history
 * stores; with neither populated the section stays empty and hides itself.
 */
export function renderRecentActivity(query: string): void {
  const section = document.getElementById('home-recent-activity');
  if (!section) return;
  section.innerHTML = '';

  const recentItems: ConnectionItem[] = [];
  for (const c of loadRecentConnections()) {
    recentItems.push({
      type: 'ssh',
      key: sshKey(c.name),
      name: c.name || c.host,
      detail: `${c.username}@${c.host}${c.port && c.port !== 22 ? `:${c.port}` : ''}`,
      raw: c,
    });
  }
  for (const r of loadRecentRemoteConnections()) {
    recentItems.push({
      type: 'remote',
      key: remoteKey(r.host, r.port),
      name: r.name || r.host,
      detail: `${r.host}:${r.port}`,
      raw: r,
    });
  }

  const items = filterConnections(recentItems, query);
  if (items.length === 0) return;

  const title = document.createElement('div');
  title.className = 'home-dash-section-title';
  title.textContent = t('homeRecentActivity');
  section.appendChild(title);

  const track = document.createElement('div');
  track.className = 'home-dash-recent-track';

  for (const item of items) {
    const iconName = item.type === 'remote' ? 'remote' : item.type === 'jumpserver' ? 'jumpserver' : 'ssh';

    const card = document.createElement('div');
    card.className = `home-dash-recent-card home-dash-recent-${item.type}`;
    // Names and hosts are ellipsised inside a 220px card, so the full pair is
    // available on hover.
    card.title = `${item.name} — ${item.detail}`;
    card.innerHTML = `<span class="home-dash-recent-icon">${icon(iconName)}</span>`
      + `<div class="home-dash-recent-info">`
      + `<div class="home-dash-recent-name">${escapeHtml(item.name)}</div>`
      + `<div class="home-dash-recent-detail">${escapeHtml(item.detail)}</div>`
      + `</div>`;

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'home-dash-recent-del';
    delBtn.title = t('homeRecentRemove');
    delBtn.setAttribute('aria-label', t('homeRecentRemove'));
    delBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    delBtn.onclick = (event) => {
      event.stopPropagation();
      if (item.type === 'ssh') {
        const c = item.raw as SSHConnectionConfig;
        removeRecentConnection(c.host, c.port ?? 22, c.username);
      } else if (item.type === 'remote') {
        const r = item.raw as RemoteServerInfo;
        removeRecentRemoteConnection(r.host, r.port);
      }
      renderRecentActivity(query);
    };
    card.appendChild(delBtn);

    // Click connects straight away, exactly like a connection-list row.
    card.onclick = () => handleConnectionClick(item, card);
    track.appendChild(card);
  }

  section.appendChild(track);
  setupScrollFade(track);
}

/** Add/remove fade-left / fade-right / fade-both classes based on scroll position */
function setupScrollFade(el: HTMLElement): void {
  const update = () => {
    const canLeft = el.scrollLeft > 1;
    const canRight = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
    el.classList.remove('fade-left', 'fade-right', 'fade-both');
    if (canLeft && canRight) el.classList.add('fade-both');
    else if (canRight) el.classList.add('fade-right');
    else if (canLeft) el.classList.add('fade-left');
  };
  el.addEventListener('scroll', update, { passive: true });
  requestAnimationFrame(update);
}

// ─── Connection Groups Section ───

/** refreshView callback is injected to avoid circular imports */
export function renderGroupsSection(query: string, refreshView: () => void): void {
  const section = document.getElementById('home-groups-section');
  if (!section) return;
  section.innerHTML = '';

  const allItems = collectAllConnections();
  const filteredItems = filterConnections(allItems, query);
  const groupMap = loadGroupMap();
  const groupOrder = loadGroupOrder();
  const groupColors = loadGroupColors();
  const collapsedSet = loadGroupCollapsed();

  const grouped = new Map<string, ConnectionItem[]>();
  const ungrouped: ConnectionItem[] = [];

  for (const item of filteredItems) {
    // `visibleGroupName`, not the raw entry: a connection filed under a name the
    // app owns (`__type:ssh` from a version that accepted one) has no card here
    // — `groupOrder` filters those names out — so reading it raw would drop the
    // row off the dashboard with no way to get it back. Read as ungrouped it
    // lands in the per-type card below, which is a bucket the row menu can move
    // it out of.
    const groupName = visibleGroupName(groupMap[item.key]);
    if (groupName) {
      if (!grouped.has(groupName)) grouped.set(groupName, []);
      grouped.get(groupName)!.push(item);
    } else {
      ungrouped.push(item);
    }
  }

  // Title row with "New Group" button
  const titleRow = document.createElement('div');
  titleRow.className = 'home-dash-section-title-row';

  const titleText = document.createElement('div');
  titleText.className = 'home-dash-section-title';
  titleText.textContent = t('homeSavedConnections');
  titleRow.appendChild(titleText);

  const newGroupBtn = document.createElement('button');
  newGroupBtn.className = 'home-dash-new-group-btn';
  newGroupBtn.textContent = '+ ' + t('homeGroupNew');
  newGroupBtn.onclick = () => {
    showGroupModal('', '', (name, color) => {
      createGroup(name);
      if (color) setGroupColor(name, color);
      refreshView();
    });
  };
  titleRow.appendChild(newGroupBtn);
  section.appendChild(titleRow);

  if (filteredItems.length === 0 && !query) {
    const empty = document.createElement('div');
    empty.className = 'home-dash-empty';
    empty.textContent = t('homeNoConnections');
    section.appendChild(empty);
    return;
  }

  const groupsGrid = document.createElement('div');
  groupsGrid.className = 'home-dash-groups-grid';

  let dragSrc: HTMLElement | null = null;

  // Build all cards: named groups + type groups
  const namedCards = new Map<string, HTMLDivElement>();
  // Rows inside a card are sorted exactly the way the connection window sorts
  // them (same per-group mode, same store). Without this the card keeps the
  // stored insertion order, so a sort picked in the connection window looks like
  // it was ignored here.
  for (const groupName of groupOrder) {
    const items = sortGroupConnections(grouped.get(groupName) || [], groupName, settings.language);
    if (items.length === 0 && query) continue;
    namedCards.set(groupName, createGroupCard(groupName, items, groupMap, refreshView, groupColors[groupName], collapsedSet.has(groupName)));
  }

  // The per-type cards are the ungrouped bucket, split by kind, so they follow
  // the sort mode saved for that bucket (`null` = ungrouped).
  const ungroupedSSH = sortGroupConnections(ungrouped.filter((i) => i.type === 'ssh'), null, settings.language);
  const ungroupedRemote = sortGroupConnections(ungrouped.filter((i) => i.type === 'remote'), null, settings.language);
  const ungroupedJumpserver = sortGroupConnections(ungrouped.filter((i) => i.type === 'jumpserver'), null, settings.language);
  const typeCardMap = new Map<string, HTMLDivElement>();
  if (ungroupedSSH.length > 0) typeCardMap.set('__type:ssh', createTypeGroupCard('ssh', ungroupedSSH, groupMap, refreshView));
  if (ungroupedRemote.length > 0) typeCardMap.set('__type:remote', createTypeGroupCard('remote', ungroupedRemote, groupMap, refreshView));
  if (ungroupedJumpserver.length > 0) typeCardMap.set('__type:jumpserver', createTypeGroupCard('jumpserver', ungroupedJumpserver, groupMap, refreshView));

  // Determine render order using saved card order
  const savedCardOrder = loadCardOrder();
  const allCardKeys = new Set([...namedCards.keys(), ...typeCardMap.keys()]);
  const orderedKeys: string[] = [];

  // First: keys in saved order that still exist
  for (const key of savedCardOrder) {
    if (allCardKeys.has(key)) {
      orderedKeys.push(key);
      allCardKeys.delete(key);
    }
  }
  // Then: remaining keys not in saved order (named groups first, then type groups)
  for (const key of namedCards.keys()) {
    if (allCardKeys.has(key)) { orderedKeys.push(key); allCardKeys.delete(key); }
  }
  for (const key of typeCardMap.keys()) {
    if (allCardKeys.has(key)) { orderedKeys.push(key); }
  }

  // Render in order and bind drag reorder
  for (const key of orderedKeys) {
    const card = namedCards.get(key) || typeCardMap.get(key);
    if (!card) continue;
    setupDragReorder(card, key, groupsGrid, () => dragSrc, (v) => { dragSrc = v; }, refreshView);
    groupsGrid.appendChild(card);
  }

  section.appendChild(groupsGrid);
  setupScrollFade(groupsGrid);
}

// ─── Card width (right-edge drag) ───

/** Turn a pinned width into an inline style + the flag the CSS keys off. */
function applyPinnedWidth(card: HTMLDivElement, width: number): void {
  card.style.width = `${width}px`;
  card.dataset.fixedWidth = '1';
}

/**
 * Let a card's right edge be dragged to widen it, and apply whatever width was
 * pinned for it last time.
 *
 * Unpinned cards are a flat `flex: 0 0 260px`, so a long `user@host` is
 * ellipsised. Pinning is for the case where 260px is not enough — or is too
 * much — and `data-fixed-width` switches the card to `flex: 0 0 auto` in the
 * stylesheet so the dragged width wins. Double-clicking the handle drops the
 * pin and hands the card back to the default width.
 */
function makeCardResizable(card: HTMLDivElement, cardKey: string): void {
  const pinned = loadCardWidths()[cardKey];
  if (pinned) applyPinnedWidth(card, pinned);

  const handle = document.createElement('div');
  handle.className = 'home-dash-card-resizer';
  handle.title = t('homeGroupResizeHint');
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-label', t('homeGroupResizeHint'));
  handle.draggable = false;

  handle.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // The width handle sits over the header, which starts a card reorder on
    // mousedown — neither that nor a card click may fire from a resize.
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = card.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    card.classList.add('resizing');

    const onMove = (move: PointerEvent) => {
      applyPinnedWidth(card, dragCardWidth(startWidth, move.clientX - startX));
    };
    const finish = (persist: boolean) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      card.classList.remove('resizing');
      if (!persist) return;
      // A click with no movement would otherwise pin the card at whatever width
      // the row happened to hand it.
      const width = card.getBoundingClientRect().width;
      if (Math.abs(width - startWidth) < 1) return;
      setCardWidth(cardKey, width);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
  });

  handle.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearCardWidth(cardKey);
    card.style.width = '';
    card.removeAttribute('data-fixed-width');
  });

  card.appendChild(handle);
}

// ─── Group card ───

function createGroupCard(
  groupName: string | null, items: ConnectionItem[],
  groupMap: ConnectionGroupMap, refreshView: () => void,
  color?: string, collapsed?: boolean,
): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'home-dash-group-card';
  card.dataset.groupName = groupName || '';

  if (color) {
    card.setAttribute('data-color', color);
    card.style.setProperty('--group-color', color);
  }
  if (collapsed) card.classList.add('collapsed');

  const header = document.createElement('div');
  header.className = 'home-dash-group-header';

  const chevron = document.createElement('span');
  chevron.className = 'home-dash-group-chevron';
  chevron.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  chevron.onclick = (e) => {
    e.stopPropagation();
    if (groupName) {
      toggleGroupCollapsed(groupName);
      card.classList.toggle('collapsed');
    }
  };
  header.appendChild(chevron);

  const iconSpan = document.createElement('span');
  iconSpan.className = 'home-dash-group-icon';
  if (color) iconSpan.style.color = color;
  iconSpan.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h4.5l1 1.5H14v8H2z"/></svg>';
  header.appendChild(iconSpan);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'home-dash-group-name';
  nameSpan.textContent = groupName ?? t('homeGroupUngrouped');

  if (groupName) {
    nameSpan.ondblclick = (e) => {
      e.stopPropagation();
      startInlineRename(nameSpan, groupName, refreshView);
    };
  }
  header.appendChild(nameSpan);

  const countSpan = document.createElement('span');
  countSpan.className = 'home-dash-group-count';
  countSpan.textContent = t('homeGroupNodeCount').replace('{count}', String(items.length));
  header.appendChild(countSpan);

  if (groupName) {
    header.oncontextmenu = (e) => {
      e.preventDefault();
      showGroupContextMenu(e, groupName, refreshView);
    };
  }

  card.appendChild(header);

  const list = document.createElement('div');
  list.className = 'home-dash-group-list';
  createOverlayScrollbar({ viewport: list, container: list });

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'home-dash-group-empty';
    empty.textContent = '—';
    list.appendChild(empty);
  } else {
    for (const item of items) {
      list.appendChild(createConnectionRow(item, groupName, groupMap, refreshView));
    }
  }

  card.appendChild(list);
  // Key shared with the reorder order, so a card keeps one identity.
  makeCardResizable(card, groupName ?? '@ungrouped');
  return card;
}

// ─── Type group card (ungrouped connections by type) ───

const TYPE_GROUP_ICONS: Record<string, string> = {
  ssh: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M12.9 6.69A5 5 0 0 0 8 2.67 4.99 4.99 0 0 0 3.57 5.36 4 4 0 0 0 0 9.33c0 2.21 1.79 4 4 4h8.67a3.33 3.33 0 0 0 .23-6.64z"/><path d="M5.5 7.5l1.5 1.5-1.5 1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 10.5h2" stroke-linecap="round"/></svg>',
  remote: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2.5" width="14" height="9" rx="1.5"/><path d="M5.5 14h5"/><path d="M8 11.5V14"/></svg>',
  jumpserver: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="1.5" width="12" height="13" rx="1.5"/><path d="M5 5h6M5 8h6M5 11h3"/></svg>',
};

const TYPE_GROUP_LABELS: Record<string, string> = {
  ssh: 'SSH',
  remote: 'Remote',
  jumpserver: 'JumpServer',
};

function createTypeGroupCard(type: 'ssh' | 'remote' | 'jumpserver', items: ConnectionItem[], groupMap: ConnectionGroupMap, refreshView: () => void): HTMLDivElement {
  const card = document.createElement('div');
  card.className = `home-dash-group-card home-dash-group-type-${type}`;
  card.dataset.groupName = `__type:${type}`;

  const header = document.createElement('div');
  header.className = 'home-dash-group-header';

  const typeIcon = TYPE_GROUP_ICONS[type] || '';
  const displayName = TYPE_GROUP_LABELS[type] || t('homeGroupUngrouped');
  header.innerHTML = `<span class="home-dash-group-icon">${typeIcon}</span><span class="home-dash-group-name">${escapeHtml(displayName)}</span><span class="home-dash-group-count">${t('homeGroupNodeCount').replace('{count}', String(items.length))}</span>`;

  card.appendChild(header);

  const list = document.createElement('div');
  list.className = 'home-dash-group-list';
  createOverlayScrollbar({ viewport: list, container: list });

  for (const item of items) {
    const row = createConnectionRow(item, null, groupMap, refreshView);
    list.appendChild(row);

    if (type === 'jumpserver') {
      const config = item.raw as JumpServerConfig;
      const history = getJSAssetHistoryByFrequency(config.name).slice(0, 5);
      for (const entry of history) {
        const assetRow = createAssetHistoryRow(entry, config);
        list.appendChild(assetRow);
      }
    }
  }

  card.appendChild(list);
  // Key shared with the reorder order, so a card keeps one identity.
  makeCardResizable(card, `__type:${type}`);
  return card;
}

// ─── Asset history row (JumpServer) ───

function createAssetHistoryRow(entry: JSAssetHistoryEntry, config: JumpServerConfig): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'home-dash-conn-row home-dash-conn-jumpserver home-dash-asset-row';
  row.innerHTML = `<span class="home-dash-asset-indent">↳</span><span class="home-dash-conn-name">${escapeHtml(entry.assetName)}</span><span class="home-dash-conn-detail">${escapeHtml(entry.accountUsername)}@${escapeHtml(entry.assetAddress)}</span><span class="home-dash-asset-count">${entry.count}×</span>`;
  row.title = `${entry.assetName} (${entry.accountUsername}@${entry.assetAddress}) — ${entry.count} connections`;
  row.onclick = () => {
    (async () => {
      const { connectToAsset } = await import('./jumpserver-handler');
      const asset = { id: entry.assetId, name: entry.assetName, address: entry.assetAddress, platform: { id: 0, name: '' }, is_active: true };
      const account = { id: entry.accountId, name: entry.accountUsername, username: entry.accountUsername, has_secret: true, privileged: false };
      connectToAsset(config, asset, account);
    })();
  };
  return row;
}

// ─── Connection row ───

function createConnectionRow(item: ConnectionItem, currentGroup: string | null, _groupMap: ConnectionGroupMap, refreshView: () => void): HTMLDivElement {
  const row = document.createElement('div');
  row.className = `home-dash-conn-row home-dash-conn-${item.type}`;
  row.innerHTML = `<span class="home-dash-conn-name">${escapeHtml(item.name)}</span><span class="home-dash-conn-detail">${escapeHtml(item.detail)}</span>`;

  row.onclick = () => handleConnectionClick(item, row);
  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    showConnectionContextMenu(e, item, currentGroup, refreshView);
  };

  return row;
}

// ─── Connection click handler ───

export function handleConnectionClick(item: ConnectionItem, anchor?: HTMLElement): void {
  if (item.type === 'ssh') {
    const handler = getSSHConnectHandler();
    if (handler) {
      try {
        // handler is async (returns Promise<void>) — catch rejections
        Promise.resolve(handler(item.raw as SSHConnectionConfig))
          .catch((err) => console.error('[SSH connect error]', err));
      } catch (err) {
        console.error('[SSH connect error]', err);
      }
    }
  } else if (item.type === 'remote') {
    const info = item.raw as RemoteServerInfo;
    showRemoteCardSessionPopup(anchor || document.body, info);
  } else if (item.type === 'jumpserver') {
    const config = item.raw as JumpServerConfig;
    (async () => {
      try {
        const { handleJumpServerConnect } = await import('./jumpserver-handler');
        handleJumpServerConnect(config);
      } catch (err) {
        console.error('[JumpServer connect error]', err);
      }
    })();
  }
}

// ─── Context menus ───

/**
 * Group management menu: collapse, rename, colour, duplicate, delete.
 *
 * Shared with the standalone connections window, which renders the same group
 * headers — a group you can create in a window has to be renameable and
 * deletable in that same window, or the feature is a dead end.
 */
export function showGroupContextMenu(event: MouseEvent, groupName: string, refreshView: () => void): void {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'home-card-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const collapsedSet = loadGroupCollapsed();
  const isCollapsed = collapsedSet.has(groupName);

  const collapseItem = document.createElement('button');
  collapseItem.className = 'home-card-menu-item';
  collapseItem.textContent = isCollapsed ? t('homeGroupExpand') : t('homeGroupCollapse');
  collapseItem.onclick = () => {
    menu.remove();
    toggleGroupCollapsed(groupName);
    refreshView();
  };
  menu.appendChild(collapseItem);

  const renameItem = document.createElement('button');
  renameItem.className = 'home-card-menu-item';
  renameItem.textContent = t('homeGroupRename');
  renameItem.onclick = () => {
    menu.remove();
    showGroupModal(groupName, loadGroupColors()[groupName] || '', (newName, newColor) => {
      if (newName !== groupName) renameGroup(groupName, newName);
      if (newColor) setGroupColor(newName, newColor);
      else removeGroupColor(newName);
      refreshView();
    });
  };
  menu.appendChild(renameItem);

  const divColor = document.createElement('div');
  divColor.className = 'custom-context-menu-divider';
  menu.appendChild(divColor);

  const colorRow = document.createElement('div');
  colorRow.className = 'home-card-menu-colors';
  const currentColor = loadGroupColors()[groupName] || '';

  const noneColor = document.createElement('div');
  noneColor.className = `home-card-menu-color${!currentColor ? ' active' : ''}`;
  noneColor.style.border = '2px dashed var(--text-muted)';
  noneColor.title = t('homeGroupColorClear');
  noneColor.onclick = (e) => {
    e.stopPropagation();
    menu.remove();
    removeGroupColor(groupName);
    refreshView();
  };
  colorRow.appendChild(noneColor);

  for (const c of GROUP_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = `home-card-menu-color${c === currentColor ? ' active' : ''}`;
    swatch.style.background = c;
    swatch.onclick = (e) => {
      e.stopPropagation();
      menu.remove();
      setGroupColor(groupName, c);
      refreshView();
    };
    colorRow.appendChild(swatch);
  }
  menu.appendChild(colorRow);

  const div2 = document.createElement('div');
  div2.className = 'custom-context-menu-divider';
  menu.appendChild(div2);

  const dupItem = document.createElement('button');
  dupItem.className = 'home-card-menu-item';
  dupItem.textContent = t('homeGroupDuplicate');
  dupItem.onclick = () => {
    menu.remove();
    duplicateGroup(groupName);
    refreshView();
  };
  menu.appendChild(dupItem);

  const deleteItem = document.createElement('button');
  deleteItem.className = 'home-card-menu-item danger';
  deleteItem.textContent = t('homeGroupDelete');
  deleteItem.onclick = async () => {
    menu.remove();
    const { confirm: tauriConfirm } = await import('@tauri-apps/plugin-dialog');
    const confirmed = await tauriConfirm(t('homeGroupDeleteConfirm'), { title: t('homeGroupDelete'), kind: 'warning' });
    if (confirmed) {
      deleteGroup(groupName);
      refreshView();
    }
  };
  menu.appendChild(deleteItem);

  document.body.appendChild(menu);
  clampMenu(menu);
  autoCloseMenu(menu);
}

/**
 * Some windows may edit a connection but must not act on the dialog's "connect"
 * outcome — sessions belong to the main window alone. Such a window installs a
 * delegate here and forwards the request (type + key only, never credentials).
 * Left unset (the main window) means "connect right here".
 *
 * Mirrors how the SSH and remote dialogs already hand their connect outcome to
 * `setSSHConnectHandler` / `setRemoteConnectHandler`.
 */
let editConnectDelegate: ((item: ConnectionItem) => void) | null = null;

export function setEditConnectDelegate(delegate: ((item: ConnectionItem) => void) | null): void {
  editConnectDelegate = delegate;
}

/**
 * Re-find a connection after an edit, matched on the fields its key is built from.
 *
 * Every key derives from user-editable data (`sshKey(name)`, `remoteKey(host,
 * port)`, `jumpserverKey(name)`), so the key captured when the menu opened goes
 * stale the moment the user renames or re-points the connection. Anything that has
 * to act on the *edited* connection must look it up again instead of reusing it.
 */
export function findConnectionItem(
  type: ConnectionItem['type'],
  match: (raw: unknown) => boolean,
): ConnectionItem | undefined {
  return collectAllConnections().find((item) => item.type === type && match(item.raw));
}

/**
 * Run the edit flow for one connection.
 *
 * Runs in whichever window rendered the row. The standalone connections window
 * shows the same dialogs in place on purpose: the main window is often
 * full-screen, i.e. on its own macOS Space, so raising it there made the
 * connections window disappear entirely.
 */
export function editConnection(item: ConnectionItem, refreshView: () => void = () => {}): void {
  if (item.type === 'ssh') {
    showSSHModal(item.raw as SSHConnectionConfig);
    return;
  }
  if (item.type === 'remote') {
    showRemoteEditDialog(item.raw as RemoteServerInfo);
    return;
  }
  // JumpServer: the dialog can request a connect, and a saved config changes the
  // row's name/detail, so the list has to re-render.
  void (async () => {
    const config = item.raw as JumpServerConfig;
    const { showJumpServerConfigDialog } = await import('./jumpserver-ui');
    const result = await showJumpServerConfigDialog(config);
    if (!result) return;
    refreshView();
    if (!result.connect) return;
    if (editConnectDelegate) {
      // Re-resolve first: renaming the config moves its key.
      const saved = findConnectionItem(
        'jumpserver',
        (raw) => (raw as JumpServerConfig).name === result.config.name,
      );
      if (saved) editConnectDelegate(saved);
      return;
    }
    const { handleJumpServerConnect } = await import('./jumpserver-handler');
    handleJumpServerConnect(result.config);
  })();
}

/**
 * Connection context menu.
 *
 * `onEdit` is for a window that wants the plain edit item instead of the
 * window-specific extras `appendSshConnectionMenuItems` attaches (a dev-only
 * credential-recovery entry whose backend command the connections window is not
 * granted). It still runs `editConnection` — in that window, not elsewhere.
 */
export function showConnectionContextMenu(
  event: MouseEvent,
  item: ConnectionItem,
  currentGroup: string | null,
  refreshView: () => void,
  onEdit?: () => void,
  /**
   * The current selection, when the right-clicked row is part of one. The "move
   * to group" entries then act on all of it — a menu that moved only the row
   * under the cursor would make a multi-row selection look broken.
   */
  moveKeys?: readonly string[],
): void {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'home-card-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  if (onEdit) {
    const editItem = document.createElement('button');
    editItem.className = 'home-card-menu-item';
    editItem.textContent = t('homeEditConnection');
    editItem.onclick = () => { menu.remove(); onEdit(); };
    menu.appendChild(editItem);
  } else if (item.type === 'ssh') {
    appendSshConnectionMenuItems(menu, item.raw as SSHConnectionConfig, t('homeEditConnection'), () => {
      menu.remove();
      editConnection(item, refreshView);
    });
  } else {
    const editItem = document.createElement('button');
    editItem.className = 'home-card-menu-item';
    editItem.textContent = t('homeEditConnection');
    editItem.onclick = () => { menu.remove(); editConnection(item, refreshView); };
    menu.appendChild(editItem);
  }

  const moving = moveKeys && moveKeys.length > 0 ? [...moveKeys] : [item.key];
  const suffix = moving.length > 1 ? ` (${moving.length})` : '';

  const groups = loadGroupOrder();
  if (groups.length > 0 || currentGroup) {
    const divider = document.createElement('div');
    divider.className = 'custom-context-menu-divider';
    menu.appendChild(divider);

    for (const g of groups) {
      if (g === currentGroup) continue;
      const moveItem = document.createElement('button');
      moveItem.className = 'home-card-menu-item';
      moveItem.textContent = `→ ${g}${suffix}`;
      moveItem.onclick = () => {
        menu.remove();
        assignConnectionsToGroup(moving, g);
        refreshView();
      };
      menu.appendChild(moveItem);
    }

    if (currentGroup || moving.length > 1) {
      const ungroup = document.createElement('button');
      ungroup.className = 'home-card-menu-item';
      ungroup.textContent = `→ ${t('homeGroupUngrouped')}${suffix}`;
      ungroup.onclick = () => {
        menu.remove();
        assignConnectionsToGroup(moving, null);
        refreshView();
      };
      menu.appendChild(ungroup);
    }
  }

  const divider2 = document.createElement('div');
  divider2.className = 'custom-context-menu-divider';
  menu.appendChild(divider2);

  const deleteItem = document.createElement('button');
  deleteItem.className = 'home-card-menu-item danger';
  deleteItem.textContent = t('sshDeleteConnection');
  deleteItem.onclick = () => {
    menu.remove();
    void handleDeleteConnection(item, refreshView).catch((error) => {
      console.error('[connections] Unable to delete credential:', error);
    });
  };
  menu.appendChild(deleteItem);

  document.body.appendChild(menu);
  clampMenu(menu);
  autoCloseMenu(menu);
}

async function handleDeleteConnection(item: ConnectionItem, refreshView: () => void): Promise<void> {
  try {
    if (item.type === 'ssh') {
      await removeSSHConnection((item.raw as SSHConnectionConfig).name);
    } else if (item.type === 'remote') {
      const info = item.raw as RemoteServerInfo;
      await removeRemoteConnection(info.host, info.port);
    } else if (item.type === 'jumpserver') {
      await removeJumpServerConfig((item.raw as JumpServerConfig).name);
    }
  } catch (error) {
    // The credential is still there, so nothing changed. Tell the user (a
    // silent console.error makes a failed delete look like a dead button — the
    // standalone connections window has no visible console), then re-throw:
    // listeners must not hear about a mutation that never happened. The caller
    // logs the error.
    showToast({
      title: t('connectionDeleteFailedTitle'),
      body: t('connectionDeleteFailedBody'),
    });
    throw error;
  }
  // The connection is gone for good, so local metadata and the view must follow
  // it — even if writing the group map misbehaves, the stale row cannot stay.
  try {
    removeConnectionGroup(item.key);
  } finally {
    refreshView();
  }
}

// ─── Helpers ───

function removeContextMenu(): void {
  document.querySelector('.home-card-menu')?.remove();
}

function clampMenu(menu: HTMLElement): void {
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
}

function autoCloseMenu(menu: HTMLElement): void {
  const cleanup = () => { menu.remove(); document.removeEventListener('click', cleanup, true); };
  document.addEventListener('click', cleanup, true);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Group modal (new / rename) ───

export function showGroupModal(
  currentName: string,
  currentColor: string,
  onConfirm: (name: string, color: string) => void,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'group-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'group-modal';

  const header = document.createElement('div');
  header.className = 'group-modal-header';
  header.textContent = currentName ? t('homeGroupRename') : t('homeGroupNew');
  modal.appendChild(header);

  const body = document.createElement('div');
  body.className = 'group-modal-body';

  const nameInput = document.createElement('input');
  nameInput.className = 'group-modal-input';
  nameInput.type = 'text';
  nameInput.placeholder = t('homeGroupNewName');
  nameInput.value = currentName;
  body.appendChild(nameInput);

  // Validation has to be visible: a reserved name is refused by `createGroup` /
  // `renameGroup`, so accepting the dialog and closing silently would look like
  // the group was created and then lost. See `isReservedGroupName`.
  const nameError = document.createElement('div');
  nameError.className = 'group-modal-error';
  nameError.hidden = true;
  body.appendChild(nameError);

  const clearNameError = () => { nameError.hidden = true; nameError.textContent = ''; };
  nameInput.oninput = clearNameError;

  let selectedColor = currentColor;
  const colorPicker = document.createElement('div');
  colorPicker.className = 'group-color-picker';

  const noneSwatch = document.createElement('div');
  noneSwatch.className = `group-color-swatch-none${!selectedColor ? ' selected' : ''}`;
  noneSwatch.textContent = '×';
  noneSwatch.onclick = () => {
    selectedColor = '';
    colorPicker.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    noneSwatch.classList.add('selected');
  };
  colorPicker.appendChild(noneSwatch);

  for (const c of GROUP_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = `group-color-swatch${c === selectedColor ? ' selected' : ''}`;
    swatch.style.background = c;
    swatch.onclick = () => {
      selectedColor = c;
      colorPicker.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
      swatch.classList.add('selected');
    };
    colorPicker.appendChild(swatch);
  }
  body.appendChild(colorPicker);

  const actions = document.createElement('div');
  actions.className = 'group-modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'group-modal-btn';
  cancelBtn.textContent = t('sshUnsavedCancel');
  cancelBtn.onclick = () => overlay.remove();
  actions.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'group-modal-btn group-modal-btn-primary';
  confirmBtn.textContent = currentName ? t('homeGroupRename') : t('homeGroupNew');
  confirmBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) return;
    if (isReservedGroupName(name)) {
      nameError.textContent = t('homeGroupNameReserved');
      nameError.hidden = false;
      nameInput.focus();
      nameInput.select();
      return;
    }
    overlay.remove();
    onConfirm(name, selectedColor);
  };
  actions.appendChild(confirmBtn);

  body.appendChild(actions);
  modal.appendChild(body);
  overlay.appendChild(modal);

  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  nameInput.onkeydown = (e) => {
    if (e.key === 'Enter') confirmBtn.click();
    if (e.key === 'Escape') overlay.remove();
  };

  document.body.appendChild(overlay);
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
}

// ─── Inline rename ───

function startInlineRename(nameSpan: HTMLElement, groupName: string, refreshView: () => void): void {
  const input = document.createElement('input');
  input.className = 'home-dash-group-name-input';
  input.value = groupName;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const newName = input.value.trim();
    if (newName && newName !== groupName) {
      // Inline rename bypasses the modal, so it has to carry the check itself.
      // And it has to *say* so: the input is about to be replaced by the
      // re-render, so a refusal with no message reads as "my typing was ignored".
      // See `isReservedGroupName`.
      if (isReservedGroupName(newName)) {
        showToast({ title: t('homeGroupRename'), body: t('homeGroupNameReserved') });
      } else {
        renameGroup(groupName, newName);
      }
    }
    refreshView();
  };

  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = groupName; input.blur(); }
  };
}

// ─── Drag reorder (mouse-based for horizontal scroll) ───

/**
 * How far outside a card's own row a drag still counts as aiming at that card.
 * Half of the grid's 12px gutter, so the rows' hit areas meet exactly once and
 * the gap between two rows never leaves the placeholder undecided.
 */
const ROW_HIT_SLOP = 6;

function setupDragReorder(
  card: HTMLDivElement,
  _groupName: string,
  grid: HTMLElement,
  _getDragSrc: () => HTMLElement | null,
  _setDragSrc: (v: HTMLElement | null) => void,
  refreshView: () => void,
): void {
  const header = card.querySelector('.home-dash-group-header') as HTMLElement | null;
  if (!header) return;

  let dragging = false;
  let armed = false;  // mousedown happened, waiting for drag threshold
  let startX = 0;
  let startY = 0;
  let cardRect: DOMRect;
  let placeholder: HTMLElement | null = null;
  let clone: HTMLElement | null = null;
  let scrollRAF = 0;

  header.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, a, .home-dash-group-chevron')) return;

    e.preventDefault();
    e.stopPropagation();

    console.log('[DRAG] mousedown armed, startX:', e.clientX);
    armed = true;
    dragging = false;
    startX = e.clientX;
    startY = e.clientY;
    cardRect = card.getBoundingClientRect();

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  });

  function startEdgeScroll(mouseX: number) {
    cancelAnimationFrame(scrollRAF);
    const gridRect = grid.getBoundingClientRect();
    const edgeZone = 60; // px from edge to start scrolling
    const maxSpeed = 12; // px per frame

    const distLeft = mouseX - gridRect.left;
    const distRight = gridRect.right - mouseX;

    let speed = 0;
    if (distLeft < edgeZone && grid.scrollLeft > 0) {
      speed = -maxSpeed * (1 - distLeft / edgeZone);
    } else if (distRight < edgeZone && grid.scrollLeft < grid.scrollWidth - grid.clientWidth) {
      speed = maxSpeed * (1 - distRight / edgeZone);
    }

    if (Math.abs(speed) < 0.5) return;

    function tick() {
      if (!dragging) return;
      grid.scrollLeft += speed;
      scrollRAF = requestAnimationFrame(tick);
    }
    scrollRAF = requestAnimationFrame(tick);
  }

  function onMove(e: MouseEvent) {
    if (!armed) return;
    e.preventDefault();

    const dx = e.clientX - startX;

    if (!dragging) {
      if (Math.abs(dx) < 5 && Math.abs(e.clientY - startY) < 5) return;
      dragging = true;

      // Create a visual clone that floats with cursor
      clone = card.cloneNode(true) as HTMLElement;
      clone.classList.add('dragging');
      clone.style.cssText = `
        position: fixed;
        top: ${cardRect.top}px;
        left: ${cardRect.left}px;
        width: ${cardRect.width}px;
        height: ${cardRect.height}px;
        z-index: 9999;
        pointer-events: none;
        margin: 0;
        opacity: 0.85;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        transition: none;
      `;
      document.body.appendChild(clone);

      // Replace original card with placeholder in the grid
      placeholder = document.createElement('div');
      placeholder.className = 'home-dash-group-card-placeholder';
      placeholder.style.flex = `0 0 ${cardRect.width}px`;
      placeholder.style.height = `${cardRect.height}px`;
      card.style.display = 'none';
      card.parentElement!.insertBefore(placeholder, card);

      document.body.classList.add('home-dragging');
    }

    // Move clone
    clone!.style.left = `${cardRect.left + dx}px`;

    // Edge auto-scroll when near container boundaries
    startEdgeScroll(e.clientX);

    // Find drop target. The row counts as well as the column: cards wrap onto
    // several rows now, so an X-only test would happily drop onto a card on a
    // different row that happens to share the same horizontal range.
    const siblings = Array.from(grid.querySelectorAll('.home-dash-group-card:not([style*="display: none"])'));
    grid.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));

    let fallback: HTMLElement | null = null;
    let target: HTMLElement | null = null;
    for (const other of siblings) {
      const r = other.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right) continue;
      if (!fallback) fallback = other as HTMLElement;
      if (e.clientY >= r.top - ROW_HIT_SLOP && e.clientY <= r.bottom + ROW_HIT_SLOP) {
        target = other as HTMLElement;
        break;
      }
    }

    // Outside every card's row (above the grid, or mid-gutter) fall back to the
    // first card sharing the cursor's column, which is what this did before the
    // grid wrapped.
    const dropTarget = target ?? fallback;
    if (dropTarget) {
      const r = dropTarget.getBoundingClientRect();
      dropTarget.classList.add('drag-over');
      const mid = r.left + r.width / 2;
      if (placeholder) {
        if (e.clientX < mid) {
          grid.insertBefore(placeholder, dropTarget);
        } else if (dropTarget.nextSibling !== placeholder) {
          grid.insertBefore(placeholder, dropTarget.nextSibling);
        }
      }
    }
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    cancelAnimationFrame(scrollRAF);

    const wasDragging = dragging;
    armed = false;
    dragging = false;

    // Remove clone
    if (clone) {
      clone.remove();
      clone = null;
    }

    // Show original card at placeholder position
    card.style.display = '';
    if (placeholder && placeholder.parentElement) {
      placeholder.parentElement.insertBefore(card, placeholder);
      placeholder.remove();
    }
    placeholder = null;

    document.body.classList.remove('home-dragging');
    grid.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));

    if (!wasDragging) return;

    // Persist card display order from DOM
    const allCards = grid.querySelectorAll('.home-dash-group-card');
    const newOrder: string[] = [];
    allCards.forEach(c => {
      const name = c.getAttribute('data-group-name');
      if (name) newOrder.push(name);
    });
    if (newOrder.length > 0) {
      const savedScroll = grid.scrollLeft;
      saveCardOrder(newOrder);
      refreshView();
      // Restore scroll position after re-render
      requestAnimationFrame(() => {
        const newGrid = document.querySelector('.home-dash-groups-grid') as HTMLElement | null;
        if (newGrid) newGrid.scrollLeft = savedScroll;
      });
    }
  }
}
