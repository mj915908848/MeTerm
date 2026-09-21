/**
 * server-info-panel.ts — Standalone, left-docked server info panel.
 *
 * The server info used to live inside the file drawer's sidebar. It is now its
 * own panel so:
 *   - the drawer is purely files + processes, and
 *   - the left dock can be given to server info (the connection list moved to
 *     its own window — see connections-window.ts).
 *
 * Like the old docked connection sidebar, it mounts as the leftmost child of
 * #main-content and pushes the terminal aside rather than covering it.
 *
 * Data path: the session's FileManager (already owned by DrawerManager) speaks
 * the same MsgServerInfo channel the drawer used, so sysinfo arrives over the
 * existing connection — no second session, no extra socket. Responses land in
 * DrawerManager, which stores them on the instance and re-renders into whichever
 * container is registered here (drawer-system-info.ts).
 */
import { t } from './i18n';
import { TerminalRegistry } from './terminal';
import { TabManager } from './tabs';
import { DrawerManager } from './drawer';
import { renderSysInfo, registerSysInfoContainer, unregisterSysInfoContainer } from './drawer-system-info';
import { loadSettings, updateSettings } from './themes';
import { escapeHtml } from './status-bar';

const MIN_WIDTH = 140;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 280;
/** Matches the compact breakpoint in drawer-system-info.ts. */
const COMPACT_BREAKPOINT = 104;
const SYSINFO_INTERVAL_MS = 5000;

function clampWidth(w: number): number {
  const max = Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.5));
  return Math.max(MIN_WIDTH, Math.min(max, Math.round(w)));
}

function loadWidth(): number {
  const w = loadSettings().sidebarWidth;
  return w > 0 ? clampWidth(w) : DEFAULT_WIDTH;
}

class ServerInfoPanelClass {
  private panel: HTMLDivElement | null = null;
  private bodyEl: HTMLDivElement | null = null;
  private infoEl: HTMLDivElement | null = null;
  private sessionId: string | null = null;
  private compact = false;
  private _open = false;
  private timer: number | null = null;

  /** User intent: has the panel been pinned open? */
  isOpen(): boolean {
    return this._open;
  }

  toggle(): void {
    if (this._open) this.close();
    else this.open();
  }

  open(): void {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;
    if (!this.panel) this.build();
    const panel = this.panel!;

    panel.style.width = `${loadWidth()}px`;
    if (panel.parentElement !== mainContent || mainContent.firstChild !== panel) {
      mainContent.insertBefore(panel, mainContent.firstChild);
    }
    panel.style.display = '';
    this._open = true;

    // Single left dock: the file sidebar (sidebar mode) has to give way.
    void import('./file-manager-toggle').then((m) => m.closeFileSidebarForDockSwap());

    this.syncToActiveSession();
    this.requestSysInfo();
    TerminalRegistry.resizeAll();
    this.renderToolbar();
  }

  close(): void {
    this._open = false;
    this.stopPolling();
    this.releaseContainer();
    const panel = this.panel;
    if (panel) { panel.style.display = 'none'; panel.style.width = ''; }
    TerminalRegistry.resizeAll();
    this.renderToolbar();
  }

  /**
   * Follow the active tab's session. Called from activateTab / showHomeView, so
   * the panel always describes the terminal the user is looking at.
   */
  syncToActiveSession(): void {
    if (!this._open) return;
    const sessionId = TabManager.getActiveSessionId() ?? null;
    const changed = sessionId !== this.sessionId;
    if (changed) {
      this.releaseContainer();
      this.sessionId = sessionId;
      this.infoEl = null;
      this.compact = false;
    }
    if (!sessionId) {
      // Home/gallery view: nothing to describe. Keep the pin, hide the panel.
      this.stopPolling();
      if (this.panel) this.panel.style.display = 'none';
      TerminalRegistry.resizeAll();
      return;
    }
    if (this.panel && this.panel.style.display === 'none') {
      this.panel.style.display = '';
      TerminalRegistry.resizeAll();
    }
    // Unconditional on purpose: startPolling() is a no-op while the timer is
    // already running, and calling it only on `changed` left the timer stopped
    // after a close()/open() cycle — same session, so `changed` is false, but
    // close() had already cleared the interval and the panel froze on stale data.
    this.startPolling();
    this.render();
  }

  /** Re-render after a connection-info update (host/user change). */
  private onConnUpdated = (event: Event): void => {
    const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
    if (!detail?.sessionId || detail.sessionId !== this.sessionId) return;
    this.infoEl = null; // force a rebuild so the new host/user is used
    this.render();
  };

  // ── Rendering ──

  private render(): void {
    if (!this.bodyEl) return;
    const sessionId = this.sessionId;
    if (!sessionId) return;

    const instance = DrawerManager.getInstance(sessionId);
    if (!instance || instance.executorType !== 'ssh') {
      // Local sessions have no remote exec channel, and JumpServer's Koko proxy
      // does not support exec sessions either — sysinfo needs a real SSH exec.
      this.releaseContainer();
      this.infoEl = null;
      this.bodyEl.innerHTML = `<div class="sip-empty">${t('serverInfoPanelUnavailable')}</div>`;
      return;
    }

    if (!this.infoEl || this.infoEl.id !== `server-info-${sessionId}`) {
      this.bodyEl.innerHTML = '';
      const infoEl = document.createElement('div');
      infoEl.className = 'server-info';
      infoEl.id = `server-info-${sessionId}`;
      this.bodyEl.appendChild(infoEl);
      this.infoEl = infoEl;
    }

    const info = DrawerManager.getServerInfo(sessionId);
    this.infoEl.innerHTML = `${this.connBlock(info)}`
      + (instance.sysInfo ? '' : `<div class="server-info-loading">${t('serverInfoLoading')}</div>`);

    registerSysInfoContainer(sessionId, this.bodyEl);
    if (instance.sysInfo) renderSysInfo(instance);
  }

  private connBlock(info: { host: string; username: string; port: number } | null): string {
    if (!info) return '';
    const host = `${info.host}${info.port && info.port !== 22 ? ':' + info.port : ''}`;
    return `<div class="server-info-conn">
      <div class="server-info-item">
        <div class="server-info-label">${t('serverInfoHost')}</div>
        <div class="server-info-value">${escapeHtml(host)}</div>
      </div>
      <div class="server-info-item">
        <div class="server-info-label">${t('serverInfoUser')}</div>
        <div class="server-info-value">${escapeHtml(info.username)}</div>
      </div>
    </div>`;
  }

  private releaseContainer(): void {
    if (this.sessionId) unregisterSysInfoContainer(this.sessionId);
  }

  // ── sysinfo polling ──

  private startPolling(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.requestSysInfo(), SYSINFO_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private requestSysInfo(): void {
    const sessionId = this.sessionId;
    if (!this._open || !sessionId) return;
    DrawerManager.getFileManager(sessionId)?.requestServerInfo('sysinfo');
  }

  /** Compact/expanded layout follows the panel's own width. */
  private syncCompactLayout(): void {
    if (!this.bodyEl) return;
    const isCompact = this.bodyEl.offsetWidth < COMPACT_BREAKPOINT;
    if (isCompact === this.compact) return;
    this.compact = isCompact;
    this.render();
  }

  // ── DOM ──

  private renderToolbar(): void {
    void import('./toolbar').then(({ renderToolbarActions }) => renderToolbarActions());
  }

  private build(): void {
    const panel = document.createElement('div');
    panel.className = 'server-info-panel';
    panel.id = 'server-info-panel';

    const header = document.createElement('div');
    header.className = 'sip-header';

    const title = document.createElement('span');
    title.className = 'sip-header-title';
    title.textContent = t('serverInfoToggle');
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'sip-close';
    closeBtn.title = t('serverInfoPanelClose');
    closeBtn.setAttribute('aria-label', t('serverInfoPanelClose'));
    closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 9 9M9 1 1 9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    closeBtn.onclick = () => this.close();
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'server-info-panel-body';
    panel.appendChild(body);
    this.bodyEl = body;

    // Drag handle on the right edge — shares sidebarWidth with the file sidebar.
    const resizer = document.createElement('div');
    resizer.className = 'server-info-panel-resizer';
    resizer.addEventListener('mousedown', (e) => this.startResize(e, panel, resizer));
    panel.appendChild(resizer);

    window.addEventListener('meterm-server-conn-updated', this.onConnUpdated);

    this.panel = panel;
  }

  /** Drag the right edge to resize; the width is persisted and shared with the
   *  file sidebar so switching between the two keeps the same geometry. */
  private startResize(e: MouseEvent, panel: HTMLElement, resizer: HTMLElement): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    let latestW = startW;
    let raf = 0;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      latestW = clampWidth(startW + (ev.clientX - startX));
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          panel.style.width = `${latestW}px`;
          this.syncCompactLayout();
        });
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      resizer.classList.remove('dragging');
      panel.style.width = `${latestW}px`;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      updateSettings({ sidebarWidth: latestW });
      this.syncCompactLayout();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
}

export const ServerInfoPanel = new ServerInfoPanelClass();
