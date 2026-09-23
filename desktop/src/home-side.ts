import { sortGroupConnections } from './connection-sort';
import { showGroupSortMenu } from './group-sort-menu';
// Home left sidebar — compact grouped connection list (search-filtered).
// Reuses the connection data + context menu from home-dashboard-left.

import { t } from './i18n';
import { icon } from './icons';
import { settings } from './app-state';
import {
  type ConnectionItem,
  collectAllConnections,
  filterConnections,
  escapeHtml,
  showConnectionContextMenu,
} from './home-dashboard-left';
import {
  loadGroupMap,
  loadGroupOrder,
  loadGroupCollapsed,
  toggleGroupCollapsed,
} from './connection-groups';

const UNGROUPED = '__ungrouped__';
const L = (zh: string, en: string): string => (settings?.language === 'zh' ? zh : en);

const STAR_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 3.2l2.7 5.5 6 .9-4.35 4.2 1.03 6L12 17l-5.38 2.8 1.03-6L3.3 9.6l6-.9z"/></svg>`;

// ── Pin (favorites) persistence ──
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

export const connTypeIcon = (type: ConnectionItem['type']): 'ssh' | 'remote' | 'jumpserver' =>
  type === 'remote' ? 'remote' : type === 'jumpserver' ? 'jumpserver' : 'ssh';

export interface SidebarListDeps {
  onSelect: (item: ConnectionItem) => void;
  refresh: () => void;
  getSelectedKey: () => string | null;
  /**
   * Run the edit flow for a row. Optional: without it the menu builder uses the
   * full in-window menu (`appendSshConnectionMenuItems`), which attaches a
   * dev-only credential-recovery entry this list is not granted. The standalone
   * connections window passes its own runner — same `editConnection`, same
   * window, just without that extra entry.
   */
  onEdit?: (item: ConnectionItem) => void;
  /** Multi-select: rows the owning window currently holds. */
  isRowSelected?: (key: string) => boolean;
  /**
   * Multi-select: the keys the owning window holds right now.
   *
   * The row menu needs this so that "move to group" can act on the whole
   * selection rather than the row under the cursor — see the `moveKeys`
   * parameter of `showConnectionContextMenu`. Optional on purpose: a list with
   * no selection concept, or a caller that does not pass it, keeps the
   * single-row behaviour instead of silently moving nothing.
   */
  getSelection?: () => string[];
  /**
   * Multi-select: called on every row click before anything opens. Returning
   * true also opens the connection — which is what an unmodified click must
   * keep doing. `visibleKeys` is the rendered row order, so a shift-click can
   * range over exactly what is on screen.
   */
  onRowClick?: (
    item: ConnectionItem,
    mods: { toggle: boolean; range: boolean },
    visibleKeys: string[],
  ) => boolean;
  /** Group header right-click. `null` addresses the ungrouped bucket. */
  onGroupContextMenu?: (event: MouseEvent, group: string | null) => void;
}

/** Render the grouped, filtered connection list into `listEl`. */
export function renderSidebarList(listEl: HTMLElement, headerSlot: HTMLElement | null, query: string, deps: SidebarListDeps): void {
  listEl.innerHTML = '';
  listEl.classList.remove('is-faded', 'at-top', 'at-bottom');
  if (headerSlot) headerSlot.innerHTML = '';
  const all = filterConnections(collectAllConnections(), query);

  const groupMap = loadGroupMap();
  const order = loadGroupOrder();
  const collapsed = loadGroupCollapsed();
  const selectedKey = deps.getSelectedKey();

  const buckets = new Map<string, ConnectionItem[]>();
  for (const item of all) {
    const g = groupMap[item.key] || UNGROUPED;
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g)!.push(item);
  }

  // A named group is rendered even when it holds nothing: it is the drop target
  // a user creates one moment before dragging rows into it, and hiding it would
  // make the group they just made look like it never happened. While searching
  // the list stays limited to groups that actually matched.
  const groupNames: string[] = [];
  for (const g of order) if (g !== UNGROUPED && (buckets.has(g) || !query)) groupNames.push(g);
  for (const g of buckets.keys()) if (g !== UNGROUPED && !groupNames.includes(g)) groupNames.push(g);
  // The ungrouped bucket is the list's root: it is always there, so there is
  // always somewhere to drag a row out of a group.
  if (!query) groupNames.push(UNGROUPED);

  // Only the ungrouped bucket and no connections at all → the plain empty state.
  if (all.length === 0 && (query || groupNames.length <= 1)) {
    const empty = document.createElement('div');
    empty.className = 'home-side-empty';
    empty.textContent = query ? L('无匹配连接', 'No matching connections') : L('暂无连接，点上方按钮新建', 'No connections yet — add one above');
    listEl.appendChild(empty);
    return;
  }

  // Single group → pull its header into the crisp fixed slot above the list, and put
  // only its rows in the (featherable) scroll area. Multiple groups → keep everything
  // in the scroll with no feather (the group names structure the list).
  const singleGroup = !!headerSlot && groupNames.length === 1;

  // Rows are ordered by their group's saved sort mode — the exact call the home
  // page's cards make, so the two lists can never disagree about the order.
  const plan = groupNames.map(g => ({
    name: g,
    items: sortGroupConnections(buckets.get(g) ?? [], g, settings.language),
    collapsed: !query && collapsed.has(g),
  }));

  // The rows actually on screen, in render order. A shift-click ranges over this
  // and nothing else, so a range can never silently swallow a collapsed group.
  const visibleKeys: string[] = [];
  for (const entry of plan) {
    if (entry.collapsed) continue;
    for (const item of entry.items) visibleKeys.push(item.key);
  }

  for (const { name: g, items, collapsed: isCollapsed } of plan) {
    const isUngrouped = g === UNGROUPED;

    const header = document.createElement('div');
    header.className = 'home-side-group' + (isCollapsed ? ' collapsed' : '');
    header.dataset.group = g;
    header.innerHTML = `<span class="hsg-chevron">${icon('chevronRight')}</span>`
      + `<span class="hsg-name">${isUngrouped ? t('homeGroupUngrouped') : escapeHtml(g)}</span>`
      + `<span class="hsg-count">${items.length}</span>`;
    const sortButton = document.createElement('button');
    sortButton.type = 'button';
    sortButton.className = 'hsg-sort';
    sortButton.dataset.group = g;
    sortButton.innerHTML = icon('sort');
    sortButton.title = t('connectionSort');
    sortButton.setAttribute('aria-label', `${isUngrouped ? t('homeGroupUngrouped') : g}: ${t('connectionSort')}`);
    sortButton.setAttribute('aria-haspopup', 'menu');
    sortButton.setAttribute('aria-expanded', 'false');
    sortButton.onclick = event => {
      event.stopPropagation();
      showGroupSortMenu(sortButton, g, deps.refresh);
    };
    header.appendChild(sortButton);
    header.onclick = () => {
      if (query) return; // can't collapse while filtering
      toggleGroupCollapsed(g);
      deps.refresh();
    };
    if (deps.onGroupContextMenu) {
      const openGroupMenu = deps.onGroupContextMenu;
      header.oncontextmenu = (event) => {
        event.preventDefault();
        openGroupMenu(event, isUngrouped ? null : g);
      };
    }
    (singleGroup ? headerSlot! : listEl).appendChild(header);

    if (isCollapsed) continue;

    if (items.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'home-side-group-empty';
      hint.textContent = t('connectionGroupEmptyHint');
      listEl.appendChild(hint);
      continue;
    }

    for (const item of items) {
      const row = document.createElement('div');
      row.className = `home-side-row home-side-row-${item.type}` + (item.key === selectedKey ? ' selected' : '');
      row.dataset.key = item.key;
      row.dataset.group = g;
      if (deps.isRowSelected?.(item.key)) row.classList.add('hsr-picked');
      const pinned = isPinned(item.key);
      row.innerHTML = `<span class="hsr-icon">${icon(connTypeIcon(item.type))}</span>`
        + `<span class="hsr-name" title="${escapeHtml(item.detail)}">${escapeHtml(item.name)}</span>`
        + `<button class="hsr-pin${pinned ? ' pinned' : ''}" type="button" tabindex="-1" title="${L('收藏', 'Pin')}">${STAR_SVG}</button>`;
      const onRowClick = deps.onRowClick;
      row.onclick = (event) => {
        if (!onRowClick) { deps.onSelect(item); return; }
        const connect = onRowClick(item, {
          toggle: event.metaKey || event.ctrlKey,
          range: event.shiftKey,
        }, visibleKeys);
        if (connect) deps.onSelect(item);
      };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        // Only a selection that *contains* this row may act for it. Right-
        // clicking a row outside the current selection means "just this row", and
        // letting a stale selection move instead is exactly how a batch menu ends
        // up moving rows the user is not pointing at.
        const selection = deps.getSelection?.();
        const moveKeys = selection?.includes(item.key) ? selection : undefined;
        showConnectionContextMenu(
          e,
          item,
          isUngrouped ? null : g,
          deps.refresh,
          deps.onEdit ? () => deps.onEdit!(item) : undefined,
          moveKeys,
        );
      };
      const pinBtn = row.querySelector('.hsr-pin') as HTMLButtonElement;
      pinBtn.onclick = (e) => {
        e.stopPropagation();
        togglePin(item.key);
        deps.refresh();
      };
      listEl.appendChild(row);
    }
  }

  // Feather the rows' top/bottom only when the single group's list overflows. The lone
  // header sits crisp in the slot above; with multiple groups we never feather.
  if (singleGroup) {
    const overflow = listEl.clientHeight > 0 && listEl.scrollHeight > listEl.clientHeight + 1;
    listEl.classList.toggle('is-faded', overflow);
    // Fresh render is scrolled to top → keep the first row crisp (no top fade yet).
    listEl.classList.toggle('at-top', listEl.scrollTop <= 0);
    listEl.classList.toggle('at-bottom', listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 1);
  }
}
