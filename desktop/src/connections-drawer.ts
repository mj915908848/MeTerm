/**
 * connections-drawer.ts — Pick a connection from the left dock.
 *
 * The toolbar's connection button (and ⌘⇧O / Ctrl+Shift+O) opens this list as
 * one of the left-dock panels (dock-panel.ts): the same card, header, width and
 * entrance as the server-info panel and the file sidebar. The dock holds one
 * panel at a time, so opening the list closes the other two, and opening either
 * of them closes the list.
 *
 * The drawer is for *choosing* a connection: search, click (or Enter) to open,
 * or start a new one. Managing connections — editing, deleting, groups — lives
 * on the home page, which the footer links to. So rows here have no context
 * menu, no multi-select and no dragging.
 *
 * It replaces a standalone connections window. That window owned no sessions,
 * so every click had to be routed to the app window that opened it, and when
 * that window was full-screen (its own macOS Space) focusing it switched Spaces
 * and made the list vanish. The drawer lives in the window whose sessions it
 * opens, so a pick is a plain local call.
 */
import { t } from './i18n';
import { createOverlayScrollbar } from './overlay-scrollbar';
import { renderSidebarList } from './home-side';
import { collectAllConnections, handleConnectionClick, type ConnectionItem } from './home-dashboard-left';
import { makeNewButtons, runNewConnectionAction } from './connection-sidebar';
import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { settings } from './app-state';
import { attachDockResizer, createDockHeader, loadDockWidth, mountInDock } from './dock-panel';

interface DrawerState {
  root: HTMLElement;
  searchInput: HTMLInputElement;
  refresh: () => void;
  dispose: () => void;
  /** Where focus was before the drawer took it, so closing can hand it back. */
  returnFocus: HTMLElement | null;
}

let drawer: DrawerState | null = null;

export function isConnectionsDrawerOpen(): boolean {
  return drawer !== null;
}

export function toggleConnectionsDrawer(): void {
  if (drawer) closeConnectionsDrawer();
  else openConnectionsDrawer();
}

export function closeConnectionsDrawer(options: { restoreFocus?: boolean } = {}): void {
  if (!drawer) return;
  const { dispose, returnFocus } = drawer;
  drawer = null;
  dispose();
  syncToolbarButton();
  if (options.restoreFocus !== false && returnFocus?.isConnected) returnFocus.focus();
}

/**
 * Keep an open drawer in step with connection edits. Saves made on the home
 * page (or in a dialog) announce themselves with this document event.
 */
export function setupConnectionsDrawerSync(): void {
  document.addEventListener('ssh-connections-changed', () => drawer?.refresh());
}

function syncToolbarButton(): void {
  document.querySelector('.conn-toggle-btn')?.classList.toggle('active', drawer !== null);
}

/** A dialog or menu is on top: Escape belongs to it, not to the drawer. */
function overlayAboveDrawer(): boolean {
  return document.querySelector('.ssh-modal-overlay, .home-card-menu, .context-menu, [role="dialog"]') !== null;
}

export function openConnectionsDrawer(): void {
  if (drawer) {
    drawer.searchInput.focus();
    return;
  }

  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const cleanups: Array<() => void> = [];

  const panel = document.createElement('aside');
  panel.className = 'dock-panel cn-drawer';
  panel.setAttribute('aria-label', t('connectionsWindowTitle'));
  panel.style.width = `${loadDockWidth()}px`;
  panel.appendChild(createDockHeader(t('connectionsWindowTitle'), L('关闭', 'Close'), () => closeConnectionsDrawer()));

  const toolbar = document.createElement('div');
  toolbar.className = 'cn-toolbar';
  const searchWrap = document.createElement('div');
  searchWrap.className = 'home-side-search cn-search';
  searchWrap.innerHTML = `<span class="home-side-search-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg></span>`;
  const searchInput = document.createElement('input');
  searchInput.className = 'home-side-search-input';
  searchInput.type = 'text';
  searchInput.placeholder = t('homeSearchPlaceholder');
  searchInput.setAttribute('aria-label', t('homeSearchPlaceholder'));
  searchWrap.appendChild(searchInput);
  toolbar.appendChild(searchWrap);
  panel.appendChild(toolbar);

  // A new connection opens its own dialog; the drawer gets out of the way first.
  panel.appendChild(makeNewButtons((kind) => {
    closeConnectionsDrawer({ restoreFocus: false });
    runNewConnectionAction(kind);
  }));

  const groupHeader = document.createElement('div');
  groupHeader.className = 'home-side-grouphdr';
  panel.appendChild(groupHeader);

  const listScroll = document.createElement('div');
  listScroll.className = 'home-side-list cn-list';
  listScroll.addEventListener('scroll', () => {
    listScroll.classList.toggle('at-top', listScroll.scrollTop <= 0);
    listScroll.classList.toggle('at-bottom', listScroll.scrollTop + listScroll.clientHeight >= listScroll.scrollHeight - 1);
  }, { passive: true });
  createOverlayScrollbar({ viewport: listScroll, container: listScroll });
  panel.appendChild(listScroll);

  // Managing connections happens on the home page.
  const footer = document.createElement('div');
  footer.className = 'cn-footer';
  const manageBtn = document.createElement('button');
  manageBtn.type = 'button';
  manageBtn.className = 'cn-manage';
  manageBtn.textContent = L('管理连接 →', 'Manage connections →');
  manageBtn.title = L('在首页编辑、删除和分组', 'Edit, delete and group on the home page');
  manageBtn.onclick = () => {
    closeConnectionsDrawer({ restoreFocus: false });
    void Promise.all([import('./view-manager'), import('./tab-renderer')]).then(([views, tabs]) => {
      views.showHomeView();
      tabs.renderTabs();
    });
  };
  footer.appendChild(manageBtn);
  panel.appendChild(footer);

  /** Open a session for this connection here, and get out of its way. */
  const connect = (item: ConnectionItem): void => {
    closeConnectionsDrawer({ restoreFocus: false });
    handleConnectionClick(item);
  };

  const refresh = (): void => {
    renderSidebarList(listScroll, groupHeader, searchInput.value.trim(), {
      onSelect: connect,
      // Pinning and per-group sort are view preferences, not management: they
      // re-render here and nowhere else needs to hear about them.
      refresh: () => refresh(),
      getSelectedKey: () => null,
      rowMenu: false,
    });
  };

  searchInput.addEventListener('input', refresh);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      // Type a few letters, press Enter: the first row that is still visible opens.
      const key = listScroll.querySelector<HTMLElement>('.home-side-row')?.dataset.key;
      const item = key ? collectAllConnections().find((i) => i.key === key) : undefined;
      if (item) {
        e.preventDefault();
        connect(item);
      }
    }
  });

  // Escape (with focus in the list) clears the search first, then closes. A
  // dialog or menu on top handles its own Escape.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.isComposing || overlayAboveDrawer()) return;
    if (!panel.contains(document.activeElement)) return;
    e.preventDefault();
    e.stopPropagation();
    if (searchInput.value && document.activeElement === searchInput) {
      searchInput.value = '';
      refresh();
      return;
    }
    closeConnectionsDrawer();
  };
  document.addEventListener('keydown', onKeyDown, true);
  cleanups.push(() => document.removeEventListener('keydown', onKeyDown, true));

  // A session that starts some other way while the drawer is open (a dialog's
  // connect, a shortcut) means the drawer is done. So does switching tabs: the
  // tab being shown may bring its own server-info panel or file sidebar back
  // into the dock.
  let tabCount = TabManager.tabs.length;
  const activeTab = TabManager.activeTabId;
  cleanups.push(TabManager.subscribe(() => {
    const now = TabManager.tabs.length;
    if (now > tabCount || TabManager.activeTabId !== activeTab) closeConnectionsDrawer({ restoreFocus: false });
    tabCount = now;
  }));

  attachDockResizer(panel);
  if (!mountInDock(panel)) return;
  // One panel in the left dock: server info and the file sidebar give way.
  void import('./server-info-panel').then((m) => { if (m.ServerInfoPanel.isOpen()) m.ServerInfoPanel.close(); });
  void import('./file-manager-toggle').then((m) => m.closeFileSidebarForDockSwap());
  drawer = {
    root: panel,
    searchInput,
    refresh,
    returnFocus,
    dispose: () => {
      for (const cleanup of cleanups) cleanup();
      panel.remove();
      TerminalRegistry.resizeAll();
    },
  };
  syncToolbarButton();
  refresh();
  TerminalRegistry.resizeAll();
  searchInput.focus();
}

/** Bilingual text for strings that are not in the i18n table. */
const L = (zh: string, en: string): string => (settings?.language === 'zh' ? zh : en);
