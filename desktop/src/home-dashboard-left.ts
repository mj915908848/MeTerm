/**
 * Home Dashboard — shared connection pieces: collecting and filtering saved
 * connections, the recent-connections track, connecting, the row and group
 * menus, deleting, and the group modal. The saved-connection manager itself
 * (list + detail panel) is home-connection-manager.ts.
 */
import { settings } from './app-state';
import { t } from './i18n';
import { icon } from './icons';
import { showToast } from './notify';
import { appendSshConnectionMenuItems } from './development-credential-recovery-ui';
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
  type JumpServerConfig,
  loadJumpServerConfigs,
  removeJumpServerConfig,
} from './jumpserver-api';
import {
  loadGroupOrder,
  getConnectionGroup,
  sshKey,
  jumpserverKey,
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
  type JSAssetHistoryEntry,
} from './connection-groups';

// ─── Types ───

export interface ConnectionItem {
  type: 'ssh' | 'jumpserver';
  key: string;
  name: string;
  detail: string;
  raw: SSHConnectionConfig | JumpServerConfig;
}

const GROUP_COLORS = ['#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#78716c'];

// ─── Collect & filter ───

export function collectAllConnections(): ConnectionItem[] {
  const items: ConnectionItem[] = [];
  for (const c of loadSavedConnections()) {
    items.push({ type: 'ssh', key: sshKey(c.name), name: c.name || c.host, detail: `${c.username}@${c.host}:${c.port}`, raw: c });
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
 * instead of one tall column. Newest entries come from the SSH history
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

  const items = filterConnections(recentItems, query);
  if (items.length === 0) return;

  const title = document.createElement('div');
  title.className = 'home-dash-section-title';
  title.textContent = t('homeRecentActivity');
  section.appendChild(title);

  const track = document.createElement('div');
  track.className = 'home-dash-recent-track';

  for (const item of items) {
    const iconName = item.type === 'jumpserver' ? 'jumpserver' : 'ssh';

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


// ─── Move menu ───

/**
 * Popup listing every group, for moving a selection without dragging. Closes on
 * the first pointer press outside — including the press that opens it again.
 */
export function showMoveMenu(anchorEl: HTMLElement, groups: string[], onPick: (group: string | null) => void): void {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'home-card-menu';
  menu.setAttribute('role', 'menu');
  const entries: [string, string | null][] = [
    ...groups.map((g): [string, string | null] => [g, g]),
    [t('homeGroupUngrouped'), null],
  ];
  for (const [label, value] of entries) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'home-card-menu-item';
    item.textContent = `→ ${label}`;
    item.onclick = () => { menu.remove(); onPick(value); };
    menu.appendChild(item);
  }
  const rect = anchorEl.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  document.body.appendChild(menu);
  clampMenu(menu);
  autoCloseMenu(menu);
}

/** A short menu of actions under a button, such as the manager's "+" and "⋯". */
export function showActionMenu(
  anchorEl: HTMLElement,
  entries: { label: string; onPick: () => void; danger?: boolean }[],
): void {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'home-card-menu';
  menu.setAttribute('role', 'menu');
  for (const entry of entries) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `home-card-menu-item${entry.danger ? ' danger' : ''}`;
    item.setAttribute('role', 'menuitem');
    item.textContent = entry.label;
    item.onclick = () => { menu.remove(); entry.onPick(); };
    menu.appendChild(item);
  }
  const rect = anchorEl.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  document.body.appendChild(menu);
  clampMenu(menu);
  autoCloseMenu(menu);
}

// ─── Asset history row (JumpServer) ───

export function createAssetHistoryRow(entry: JSAssetHistoryEntry, config: JumpServerConfig): HTMLDivElement {
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
 * Shared with the connections drawer, which renders the same group headers — a
 * group you can create in the drawer has to be renameable and deletable there
 * too, or the feature is a dead end.
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
 * Mirrors how the SSH dialog already hands its connect outcome to
 * `setSSHConnectHandler`.
 */
let editConnectDelegate: ((item: ConnectionItem) => void) | null = null;

export function setEditConnectDelegate(delegate: ((item: ConnectionItem) => void) | null): void {
  editConnectDelegate = delegate;
}

/**
 * Re-find a connection after an edit, matched on the fields its key is built from.
 *
 * Every key derives from user-editable data (`sshKey(name)`,
 * `jumpserverKey(name)`), so the key captured when the menu opened goes
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
 * Runs in whichever window rendered the row.
 *
 * Every branch has to run `refreshView` once the dialog has saved: the store is
 * shared between windows but the DOM is not, so the list the user is looking at
 * keeps showing the row it was rendered from — an old name, an old host — until
 * something re-renders it. The dialogs also announce a save on the document, which
 * only a window running `setupDomEventListeners` (not this list's own window)
 * listens for, so the callback is what carries the news here. A save by the
 * JumpServer dialog already returned through this callback; SSH used to return
 * before reaching it.
 *
 * In the window that does run those listeners the list is now rendered twice, by
 * two identical calls. That costs one re-render and saves telling the dialogs which
 * window they are in, which they have no way of knowing.
 */
export function editConnection(item: ConnectionItem, refreshView: () => void = () => {}): void {
  if (item.type === 'ssh') {
    showSSHModal(item.raw as SSHConnectionConfig, () => refreshView());
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
 * `onEdit` is for a list that wants the plain edit item instead of the extras
 * `appendSshConnectionMenuItems` attaches (a dev-only credential-recovery entry).
 * With several rows selected (`moveKeys`) the menu offers only what applies to
 * all of them: move and delete.
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

  const moving = moveKeys && moveKeys.length > 0 ? [...moveKeys] : [item.key];
  const batch = moving.length > 1;
  const suffix = batch ? ` (${moving.length})` : '';

  // Editing is a one-connection action: with several rows picked the menu only
  // offers what applies to all of them (move, delete).
  if (batch) {
    // No edit entry.
  } else if (onEdit) {
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

  /**
   * Would this destination change nothing at all?
   *
   * The entry for a row's own group used to be hidden by comparing that group
   * with the group of the row under the cursor — correct while a menu could only
   * move one row, and wrong as soon as it can move a selection: with rows picked
   * in A and B and the cursor on an A row, every B row could no longer be moved
   * into A, which is the one destination the user was most likely reaching for.
   * The question is per *batch*: hide a destination only when the whole batch is
   * already there.
   */
  const targetsNothing = (target: string | null): boolean =>
    moving.every((key) => (getConnectionGroup(key) ?? null) === target);

  const groups = loadGroupOrder();
  if (groups.length > 0 || currentGroup) {
    if (!batch) {
      const divider = document.createElement('div');
      divider.className = 'custom-context-menu-divider';
      menu.appendChild(divider);
    }

    for (const g of groups) {
      if (targetsNothing(g)) continue;
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

    if (!targetsNothing(null)) {
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

  if (menu.childElementCount > 0) {
    const divider2 = document.createElement('div');
    divider2.className = 'custom-context-menu-divider';
    menu.appendChild(divider2);
  }

  const deleteItem = document.createElement('button');
  deleteItem.className = 'home-card-menu-item danger';
  deleteItem.textContent = `${t('sshDeleteConnection')}${suffix}`;
  deleteItem.onclick = () => {
    menu.remove();
    if (batch) {
      void handleDeleteConnections(moving, refreshView);
      return;
    }
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
    } else if (item.type === 'jumpserver') {
      await removeJumpServerConfig((item.raw as JumpServerConfig).name);
    }
  } catch (error) {
    // The credential is still there, so nothing changed. Tell the user (a
    // silent console.error makes a failed delete look like a dead button — the
    // app has no visible console), then re-throw:
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

/**
 * Delete every connection in a multi-row selection.
 *
 * A single delete runs without a prompt, as it always has; several at once is
 * easy to trigger by accident, so it asks first. Each connection is removed on
 * its own: one that fails (its credential could not be deleted) stays, the rest
 * go, and the user hears about the failures once rather than once per row.
 */
export async function handleDeleteConnections(keys: readonly string[], refreshView: () => void): Promise<void> {
  const items = collectAllConnections().filter((i) => keys.includes(i.key));
  if (items.length === 0) return;
  const zh = settings?.language === 'zh';
  const { confirm: tauriConfirm } = await import('@tauri-apps/plugin-dialog');
  const message = items.length === 1
    ? (zh ? `删除连接“${items[0].name}”？此操作无法撤销。` : `Delete "${items[0].name}"? This cannot be undone.`)
    : (zh ? `删除选中的 ${items.length} 个连接？此操作无法撤销。` : `Delete ${items.length} selected connections? This cannot be undone.`);
  const confirmed = await tauriConfirm(
    message,
    { title: t('sshDeleteConnection'), kind: 'warning' },
  );
  if (!confirmed) return;

  let failed = 0;
  for (const target of items) {
    try {
      if (target.type === 'ssh') {
        await removeSSHConnection((target.raw as SSHConnectionConfig).name);
      } else if (target.type === 'jumpserver') {
        await removeJumpServerConfig((target.raw as JumpServerConfig).name);
      }
    } catch (error) {
      failed += 1;
      console.error('[connections] Unable to delete credential:', error);
      continue;
    }
    try {
      removeConnectionGroup(target.key);
    } catch (error) {
      console.error('[connections] Unable to clear group for deleted connection:', error);
    }
  }
  if (failed > 0) {
    showToast({ title: t('connectionDeleteFailedTitle'), body: t('connectionDeleteFailedBody') });
  }
  refreshView();
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
