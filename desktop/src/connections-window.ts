/**
 * connections-window.ts — The connection list in its own window.
 *
 * The toolbar's connection button used to dock the connection sidebar on the
 * left, pushing the terminal aside. It now opens this window instead, which
 * frees the left dock for the server-info panel (server-info-panel.ts).
 *
 * This window is a *navigator*: it renders the same grouped, searchable list as
 * the rest of the app but owns no sessions. Picking a connection (or a "new
 * connection" button) emits a request that the main window performs, so all
 * session state stays in one window. Only a connection type + key crosses the
 * boundary — never credentials, matching the app's credential-broker rule.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit, listen } from '@tauri-apps/api/event';
import { initLanguage, setLanguage, t } from './i18n';
import { loadSettings, resolveIsDark, type AppSettings } from './themes';
import { createUtilityWindow, revealAfterPaint } from './window-utils';
import { createOverlayScrollbar } from './overlay-scrollbar';
import { showToast } from './notify';
import { renderSidebarList } from './home-side';
import { collectAllConnections, handleConnectionClick, type ConnectionItem } from './home-dashboard-left';
import { makeNewButtons, runNewConnectionAction, type NewConnectionKind } from './connection-sidebar';
import { applyNbPalette } from './nb-palette';
import { setSettings, isWindowsPlatform, isLinuxPlatform } from './app-state';

export const CONNECTIONS_WINDOW_LABEL = 'connections';

/** Ask the main window to open a session for this connection. */
const EVENT_OPEN_REQUEST = 'connections-open-request';
/** Ask the main window to run one of the "new connection" actions. */
const EVENT_NEW_REQUEST = 'connections-new-request';
/** We changed connection data (edit/delete) — the main window should re-render. */
const EVENT_MUTATED = 'connections-mutated';

// ── Opened from the main window ──

export async function openConnectionsWindow(): Promise<void> {
  try {
    const existing = await WebviewWindow.getByLabel(CONNECTIONS_WINDOW_LABEL);
    if (existing) {
      void existing.show();
      void existing.setFocus();
      return;
    }

    await createUtilityWindow({
      label: CONNECTIONS_WINDOW_LABEL,
      url: '?window=connections',
      title: t('connectionsWindowTitle'),
      width: 400,
      height: 640,
      resizable: true,
    });
    // Show once the webview has painted, so it never flashes empty.
    setTimeout(async () => {
      const win = await WebviewWindow.getByLabel(CONNECTIONS_WINDOW_LABEL);
      if (win) void win.show().then(() => win.setFocus());
    }, 150);
  } catch (e) {
    // Fail loudly. This call is fired with `void`, so a silent rejection just
    // reads as a dead toolbar button; the usual cause is a missing window
    // capability, which produces no on-screen signal at all.
    console.error('Failed to create connections window:', e);
    showToast({
      title: t('connectionsWindowTitle'),
      body: t('connectionsWindowOpenFailed'),
    });
  }
}

// ── Main-window side of the protocol ──

/**
 * Serve requests coming from the connections window. Registered by the main
 * window only — it is the one that owns sessions and the SSH/JumpServer state.
 */
export function setupConnectionsWindowBridge(): void {
  void listen<{ type?: unknown; key?: unknown }>(EVENT_OPEN_REQUEST, async (event) => {
    const { type, key } = event.payload ?? {};
    if (typeof type !== 'string' || typeof key !== 'string') return;
    const item = collectAllConnections().find((i) => i.type === type && i.key === key);
    if (!item) return;
    await getCurrentWindow().show();
    await getCurrentWindow().setFocus();
    handleConnectionClick(item);
  });

  void listen<{ kind?: unknown }>(EVENT_NEW_REQUEST, async (event) => {
    const kind = event.payload?.kind;
    if (typeof kind !== 'string') return;
    await getCurrentWindow().show();
    await getCurrentWindow().setFocus();
    runNewConnectionAction(kind as NewConnectionKind);
  });

  // Connection metadata changed in the connections window: this window's caches
  // (home view, toolbar) read localStorage lazily, so a plain refresh is enough.
  void listen(EVENT_MUTATED, () => {
    document.dispatchEvent(new CustomEvent('ssh-connections-changed'));
    document.dispatchEvent(new CustomEvent('remote-connections-changed'));
  });
}

// ── The connections window itself ──

function resolveThemeAttr(colorScheme: AppSettings['colorScheme']): string {
  if (colorScheme === 'darker') return 'darker';
  if (colorScheme === 'navy') return 'navy';
  if (colorScheme === 'light') return 'light';
  if (colorScheme === 'neo-brutalism') return 'neo-brutalism';
  if (colorScheme === 'neo-brutalism-rounded') return 'neo-brutalism-rounded';
  if (colorScheme === 'auto') return resolveIsDark('auto') ? 'dark' : 'light';
  return 'dark';
}

export function initConnectionsWindow(): void {
  initLanguage();
  const loaded = loadSettings();
  setLanguage(loaded.language);
  setSettings(loaded);

  document.documentElement.dataset.theme = resolveThemeAttr(loaded.colorScheme);
  applyNbPalette(loaded.colorScheme);

  // Hide the main app shell — this window renders its own body.
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';
  document.body.classList.add('connections-window-mode');

  const needsCustomControls = isWindowsPlatform || isLinuxPlatform;

  if (needsCustomControls) {
    document.body.appendChild(createTitleBar());
  } else {
    const dragRegion = document.createElement('div');
    dragRegion.className = 'overlay-drag-region';
    dragRegion.setAttribute('data-tauri-drag-region', '');
    document.body.appendChild(dragRegion);
  }

  const searchWrap = document.createElement('div');
  searchWrap.className = 'home-side-search cn-search';
  searchWrap.innerHTML = `<span class="home-side-search-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg></span>`;
  const searchInput = document.createElement('input');
  searchInput.className = 'home-side-search-input';
  searchInput.type = 'text';
  searchInput.placeholder = t('homeSearchPlaceholder');
  searchInput.setAttribute('aria-label', t('homeSearchPlaceholder'));
  searchWrap.appendChild(searchInput);
  document.body.appendChild(searchWrap);

  // New-connection buttons delegate to the main window (this window has no
  // terminal to host a session).
  const newButtons = makeNewButtons((kind) => { void emit(EVENT_NEW_REQUEST, { kind }); });
  document.body.appendChild(newButtons);

  const groupHeader = document.createElement('div');
  groupHeader.className = 'home-side-grouphdr';
  document.body.appendChild(groupHeader);

  const listScroll = document.createElement('div');
  listScroll.className = 'home-side-list cn-list';
  listScroll.addEventListener('scroll', () => {
    listScroll.classList.toggle('at-top', listScroll.scrollTop <= 0);
    listScroll.classList.toggle('at-bottom', listScroll.scrollTop + listScroll.clientHeight >= listScroll.scrollHeight - 1);
  }, { passive: true });
  createOverlayScrollbar({ viewport: listScroll, container: listScroll });
  document.body.appendChild(listScroll);

  const footer = document.createElement('div');
  footer.className = 'cn-footer';
  footer.textContent = t('connectionsWindowHint');
  document.body.appendChild(footer);

  const refresh = (): void => {
    renderSidebarList(listScroll, groupHeader, searchInput.value.trim(), {
      onSelect: (item: ConnectionItem) => {
        // The main window opens the session; keep this list open as a launcher.
        void emit(EVENT_OPEN_REQUEST, { type: item.type, key: item.key });
      },
      // Edits/deletions happen against shared localStorage. Tell the main window
      // so its home view and toolbar pick the change up.
      refresh: () => {
        refresh();
        void emit(EVENT_MUTATED);
      },
      getSelectedKey: () => null,
      // Editing opens dialogs whose "connect" path needs the main window's state.
      allowEdit: false,
    });
  };

  searchInput.addEventListener('input', refresh);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      refresh();
      searchInput.blur();
    }
  });

  // Another window may have added/removed connections while this one was hidden.
  window.addEventListener('focus', refresh);
  // Settings (language, theme tokens) may change in the settings window.
  void listen('settings-changed', () => {
    setSettings(loadSettings());
    refresh();
  });

  refresh();
  void revealAfterPaint(getCurrentWindow().label);
}

function createTitleBar(): HTMLElement {
  const titleBar = document.createElement('div');
  titleBar.className = 'settings-titlebar';

  const dragRegion = document.createElement('div');
  dragRegion.className = 'settings-titlebar-drag';
  dragRegion.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  });

  const title = document.createElement('span');
  title.className = 'settings-titlebar-title';
  title.textContent = t('connectionsWindowTitle');
  dragRegion.appendChild(title);
  titleBar.appendChild(dragRegion);

  const relaunch = document.createElement('button');
  relaunch.className = 'settings-titlebar-close';
  relaunch.type = 'button';
  relaunch.title = t('connectionsWindowSettings');
  relaunch.setAttribute('aria-label', t('connectionsWindowSettings'));
  relaunch.textContent = '⋯';
  relaunch.onclick = () => { void import('./view-manager').then((m) => m.openSettings('general')); };
  titleBar.appendChild(relaunch);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-titlebar-close';
  closeBtn.type = 'button';
  closeBtn.title = t('serverInfoPanelClose');
  closeBtn.setAttribute('aria-label', t('serverInfoPanelClose'));
  closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 9 9M9 1 1 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  closeBtn.onclick = () => { void getCurrentWindow().close(); };
  titleBar.appendChild(closeBtn);

  return titleBar;
}
