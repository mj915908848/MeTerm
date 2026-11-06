/**
 * quick-switcher.ts — jump to a saved connection from anywhere.
 *
 * The toolbar's connection button (and ⌘⇧O / Ctrl+Shift+O) opens a centred
 * search box over the window: favourites and recent connections first, type a
 * few letters to narrow it down, Enter (or a click) connects. ⌘E / Ctrl+E, or
 * the pencil on a row, edits that connection in its usual dialog.
 *
 * It replaces the connections list that used to dock on the left. That list was
 * the home page's grouped list a second time, so the two looked like duplicates;
 * the switcher only *finds* connections, and everything else about managing them
 * (groups, delete, sort) stays on the home page, one row away at the bottom.
 */
import { t } from './i18n';
import { icon } from './icons';
import { settings } from './app-state';
import {
  collectAllConnections,
  editConnection,
  escapeHtml,
  filterConnections,
  handleConnectionClick,
  type ConnectionItem,
} from './home-dashboard-left';
import { isPinned } from './connection-pins';
import { loadGroupMap, sshKey, visibleGroupName } from './connection-groups';
import { loadRecentConnections } from './ssh';
import { runNewConnectionAction } from './connection-sidebar';
import { TabManager } from './tabs';

/** Bilingual text for strings that are not in the i18n table. */
const L = (zh: string, en: string): string => (settings?.language === 'zh' ? zh : en);

const SEARCH_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>';
const EDIT_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/></svg>';

/** At most this many rows per section with an empty query; typing searches everything. */
const RECENT_LIMIT = 5;

type Row =
  | { kind: 'conn'; item: ConnectionItem; tag: string }
  | { kind: 'action'; id: 'new-ssh' | 'manage'; label: string; iconName: 'plus' | 'home' };

interface Section {
  title: string | null;
  rows: Row[];
}

interface SwitcherState {
  root: HTMLElement;
  input: HTMLInputElement;
  refresh: () => void;
  dispose: () => void;
  /** Where focus was before the switcher took it, so closing can hand it back. */
  returnFocus: HTMLElement | null;
}

let state: SwitcherState | null = null;

export function isQuickSwitcherOpen(): boolean {
  return state !== null;
}

export function toggleQuickSwitcher(): void {
  if (state) closeQuickSwitcher();
  else openQuickSwitcher();
}

export function closeQuickSwitcher(options: { restoreFocus?: boolean } = {}): void {
  if (!state) return;
  const { dispose, returnFocus } = state;
  state = null;
  dispose();
  syncToolbarButton();
  if (options.restoreFocus !== false && returnFocus?.isConnected) returnFocus.focus();
}

/** Keep an open switcher in step with connection edits made elsewhere. */
export function setupQuickSwitcherSync(): void {
  document.addEventListener('ssh-connections-changed', () => state?.refresh());
}

function syncToolbarButton(): void {
  document.querySelector('.conn-toggle-btn')?.classList.toggle('active', state !== null);
}

function groupTag(item: ConnectionItem, map: Record<string, string>): string {
  return visibleGroupName(map[item.key]) ?? '';
}

/**
 * Best matches first: a name that starts with the query, then a name that
 * contains it, then an address that does. Favourites win ties.
 */
export function rankMatches(items: ConnectionItem[], query: string): ConnectionItem[] {
  const q = query.toLowerCase();
  const score = (i: ConnectionItem): number => {
    const name = i.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    return 2;
  };
  return filterConnections(items, query)
    .map((item, index) => ({ item, index, s: score(item), p: isPinned(item.key) ? 0 : 1 }))
    .sort((a, b) => a.s - b.s || a.p - b.p || a.index - b.index)
    .map((x) => x.item);
}

/** What the list shows for a query: sections of rows, actions last. */
export function buildSections(query: string): Section[] {
  const all = collectAllConnections();
  const map = loadGroupMap();
  const conn = (item: ConnectionItem): Row => ({ kind: 'conn', item, tag: groupTag(item, map) });
  const sections: Section[] = [];

  if (query) {
    const matches = rankMatches(all, query);
    if (matches.length > 0) sections.push({ title: null, rows: matches.map(conn) });
  } else {
    const byKey = new Map(all.map((i) => [i.key, i]));
    const pinned = all.filter((i) => isPinned(i.key));
    const shown = new Set(pinned.map((i) => i.key));
    const recent: ConnectionItem[] = [];
    for (const c of loadRecentConnections()) {
      const item = byKey.get(sshKey(c.name));
      if (!item || shown.has(item.key)) continue;
      shown.add(item.key);
      recent.push(item);
      if (recent.length >= RECENT_LIMIT) break;
    }
    if (pinned.length > 0) sections.push({ title: L('收藏', 'Favorites'), rows: pinned.map(conn) });
    if (recent.length > 0) sections.push({ title: L('最近使用', 'Recent'), rows: recent.map(conn) });
    const rest = all.filter((i) => !shown.has(i.key));
    if (rest.length > 0) {
      sections.push({ title: sections.length > 0 ? L('其他连接', 'Other connections') : null, rows: rest.map(conn) });
    }
  }

  sections.push({
    title: null,
    rows: [
      {
        kind: 'action',
        id: 'new-ssh',
        label: L('新建 SSH 连接…', 'New SSH connection…'),
        iconName: 'plus',
      },
      { kind: 'action', id: 'manage', label: L('去首页管理连接', 'Manage connections on the home page'), iconName: 'home' },
    ],
  });
  return sections;
}

export function openQuickSwitcher(): void {
  if (state) {
    state.input.focus();
    return;
  }

  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const cleanups: Array<() => void> = [];

  const overlay = document.createElement('div');
  overlay.className = 'qs-overlay';
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) {
      e.preventDefault();
      closeQuickSwitcher();
    }
  });

  const panel = document.createElement('div');
  panel.className = 'qs-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('connectionsWindowTitle'));
  overlay.appendChild(panel);

  const head = document.createElement('div');
  head.className = 'qs-head';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'qs-search-icon';
  searchIcon.innerHTML = SEARCH_SVG;
  const input = document.createElement('input');
  input.className = 'qs-input';
  input.type = 'text';
  input.placeholder = L('输入名称或地址，回车连接', 'Type a name or address, Enter to connect');
  input.setAttribute('aria-label', input.placeholder);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'qs-list');
  input.spellcheck = false;
  input.autocomplete = 'off';
  const kbd = document.createElement('span');
  kbd.className = 'qs-kbd';
  kbd.textContent = navigator.userAgent.includes('Mac') ? '⌘⇧O' : 'Ctrl+Shift+O';
  head.append(searchIcon, input, kbd);
  panel.appendChild(head);

  const list = document.createElement('div');
  list.className = 'qs-list';
  list.id = 'qs-list';
  list.setAttribute('role', 'listbox');
  panel.appendChild(list);

  const isMac = navigator.userAgent.includes('Mac');
  const foot = document.createElement('div');
  foot.className = 'qs-foot';
  foot.innerHTML = `<span>↑↓ ${escapeHtml(L('选择', 'Select'))}</span>`
    + `<span>↵ ${escapeHtml(L('连接', 'Connect'))}</span>`
    + `<span>${isMac ? '⌘E' : 'Ctrl+E'} ${escapeHtml(L('编辑', 'Edit'))}</span>`
    + `<span>esc ${escapeHtml(L('关闭', 'Close'))}</span>`;
  panel.appendChild(foot);

  let rows: Row[] = [];
  let active = 0;

  const run = (row: Row): void => {
    closeQuickSwitcher({ restoreFocus: false });
    if (row.kind === 'conn') {
      handleConnectionClick(row.item);
    } else if (row.id === 'new-ssh') {
      runNewConnectionAction('ssh');
    } else {
      void Promise.all([import('./view-manager'), import('./tab-renderer')]).then(([views, tabs]) => {
        views.showHomeView();
        tabs.renderTabs();
      });
    }
  };

  const edit = (row: Row): void => {
    if (row.kind !== 'conn') return;
    // The edit dialog takes over: the switcher gets out of its way.
    closeQuickSwitcher({ restoreFocus: false });
    editConnection(row.item);
  };

  const paintActive = (): void => {
    const els = list.querySelectorAll<HTMLElement>('.qs-row');
    els.forEach((el, i) => {
      const on = i === active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) {
        input.setAttribute('aria-activedescendant', el.id);
        el.scrollIntoView({ block: 'nearest' });
      }
    });
  };

  const render = (): void => {
    const sections = buildSections(input.value.trim());
    rows = [];
    list.replaceChildren();
    for (const section of sections) {
      if (section.rows.length === 0) continue;
      if (section.title) {
        const title = document.createElement('div');
        title.className = 'qs-section';
        title.textContent = section.title;
        list.appendChild(title);
      } else if (list.childElementCount > 0) {
        const sep = document.createElement('div');
        sep.className = 'qs-sep';
        list.appendChild(sep);
      }
      for (const row of section.rows) {
        const index = rows.length;
        rows.push(row);
        const el = document.createElement('div');
        el.className = `qs-row qs-row-${row.kind === 'conn' ? row.item.type : 'action'}`;
        el.id = `qs-row-${index}`;
        el.setAttribute('role', 'option');
        if (row.kind === 'conn') {
          const typeIcon = row.item.type === 'jumpserver' ? 'jumpserver' : 'ssh';
          el.innerHTML = `<span class="qs-icon">${icon(typeIcon)}</span>`
            + `<span class="qs-name">${escapeHtml(row.item.name)}</span>`
            + `<span class="qs-detail">${escapeHtml(row.item.detail)}</span>`
            + `<span class="qs-tag">${isPinned(row.item.key) ? '★ ' : ''}${escapeHtml(row.tag)}</span>`;
          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'qs-edit';
          editBtn.tabIndex = -1;
          editBtn.title = t('homeEditConnection');
          editBtn.setAttribute('aria-label', t('homeEditConnection'));
          editBtn.innerHTML = EDIT_SVG;
          editBtn.onmousedown = (e) => e.preventDefault();
          editBtn.onclick = (e) => {
            e.stopPropagation();
            edit(row);
          };
          el.appendChild(editBtn);
        } else {
          el.innerHTML = `<span class="qs-icon">${icon(row.iconName)}</span><span class="qs-name">${escapeHtml(row.label)}</span>`;
        }
        // Keep focus in the input so typing keeps narrowing the list.
        el.onmousedown = (e) => e.preventDefault();
        el.onmousemove = () => {
          if (active !== index) { active = index; paintActive(); }
        };
        el.onclick = () => run(row);
        list.appendChild(el);
      }
    }
    active = Math.min(active, Math.max(0, rows.length - 1));
    paintActive();
  };

  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length === 0) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      paintActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row) run(row);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (input.value) {
        input.value = '';
        active = 0;
        render();
      } else {
        closeQuickSwitcher();
      }
    } else if ((e.key === 'e' || e.key === 'E') && (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      const row = rows[active];
      if (row) edit(row);
    }
  });

  // A session that starts some other way, or a tab switch, means the switcher is done.
  let tabCount = TabManager.tabs.length;
  const activeTab = TabManager.activeTabId;
  cleanups.push(TabManager.subscribe(() => {
    const now = TabManager.tabs.length;
    if (now > tabCount || TabManager.activeTabId !== activeTab) closeQuickSwitcher({ restoreFocus: false });
    tabCount = now;
  }));

  document.body.appendChild(overlay);
  state = {
    root: overlay,
    input,
    refresh: render,
    returnFocus,
    dispose: () => {
      for (const cleanup of cleanups) cleanup();
      overlay.remove();
    },
  };
  syncToolbarButton();
  render();
  input.focus();
}
