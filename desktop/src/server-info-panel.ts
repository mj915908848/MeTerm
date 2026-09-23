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
import { isHomeView, isGalleryView } from './app-state';

const MIN_WIDTH = 140;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 280;
/** Matches the compact breakpoint in drawer-system-info.ts. */
const COMPACT_BREAKPOINT = 104;
const SYSINFO_INTERVAL_MS = 5000;
/**
 * The process box is a list, not a gauge: CPU, memory and network are worth
 * watching every few seconds, a top-30 `ps` snapshot is not. Every `processes`
 * request is a full `/proc` scan on the remote host, so it goes out on every
 * Nth tick instead — plus immediately whenever the panel is asked for fresh
 * context (session switched, window back in the foreground).
 */
const PROCESS_INTERVAL_MS = 30000;
const PROCESS_EVERY_TICKS = PROCESS_INTERVAL_MS / SYSINFO_INTERVAL_MS;

function clampWidth(w: number): number {
  const max = Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.5));
  return Math.max(MIN_WIDTH, Math.min(max, Math.round(w)));
}

function loadWidth(): number {
  const w = loadSettings().sidebarWidth;
  return w > 0 ? clampWidth(w) : DEFAULT_WIDTH;
}

/**
 * Server info needs a real remote exec channel, which only a plain SSH session
 * has:
 *   - a local session has no remote side at all;
 *   - a JumpServer session is an SSH connection too, but to Koko, and Koko
 *     never granted us an exec channel — its file browser works over a
 *     multiplexed SFTP subsystem on the authenticated terminal connection
 *     instead (see UPDATE.md, "JumpServer SFTP 无法初始化").
 *
 * `executorType` is resolved once per session by DrawerManager.create(), so this
 * is the same field the drawer and the file manager run on. The toolbar renders
 * its entry from this function as well — one predicate, one place to change.
 */
export function hasRemoteServerInfo(sessionId: string | null): boolean {
  if (!sessionId) return false;
  return DrawerManager.getInstance(sessionId)?.executorType === 'ssh';
}

class ServerInfoPanelClass {
  private panel: HTMLDivElement | null = null;
  private bodyEl: HTMLDivElement | null = null;
  private infoEl: HTMLDivElement | null = null;
  private sessionId: string | null = null;
  private compact = false;
  private _open = false;
  private timer: number | null = null;
  /** Ticks since the process list was last asked for — see PROCESS_EVERY_TICKS. */
  private processTick = 0;

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
   * Follow the active tab's session. Called from activateTab / showHomeView /
   * showGalleryView, so the panel always describes the terminal the user is
   * looking at.
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
    // Home / gallery display no session even though the SSH tab that owns one is
    // still open — leaving the home view only hides the terminal, it never closes
    // the tab, so the active session (and hasRemoteServerInfo) is still there and
    // the panel stayed on screen above the dashboard. Both views belong to the
    // "nothing to describe" case below.
    if (isHomeView || isGalleryView || !sessionId || !hasRemoteServerInfo(sessionId)) {
      // Nothing to describe: home/gallery has no session at all, and local /
      // JumpServer sessions have no remote exec channel to describe. Keep the
      // pin — the panel comes back with the next SSH tab.
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
    // canPoll() still gates it: this path also runs for a background window, and
    // a timer started there would poll with nothing visible at all.
    if (this.canPoll()) this.startPolling();
    // Another session means different data behind every row, and the process
    // list is polled slowly now — waiting for its next turn would show the
    // previous session's processes (or nothing) for up to 30s.
    if (changed) this.requestSysInfo(true);
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
      // Not an SSH session: syncToActiveSession() already hid the panel and the
      // toolbar has no entry for it. Clear whatever is left instead of rendering
      // a message into a hidden panel — this also drops stale numbers if the
      // session ever changes type under us.
      this.releaseContainer();
      this.infoEl = null;
      this.bodyEl.innerHTML = '';
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

  /**
   * Is there anything on screen that a poll could update?
   *
   * One gate for every path that can (re)start the timer. The check used to live
   * only in `syncToActiveSession()`, which is enough to *stop* polling but not to
   * keep it stopped: the resume signals (focus, visibility, any click) asked
   * `_open` only, and `_open` stays true while the home / gallery view has the
   * dock hidden. Clicking anywhere on the dashboard therefore restarted two SSH
   * commands per tick for a panel that was `display: none` — "nothing visible
   * means nothing to poll" held for the path that hid the panel, and not for the
   * ones that could bring it back.
   */
  private canPoll(): boolean {
    if (!this._open) return false;
    if (document.hidden) return false;
    // Home / gallery display no session even though the SSH tab behind them is
    // still open (see syncToActiveSession) — nothing of it is on screen.
    if (isHomeView || isGalleryView) return false;
    if (this.panel && this.panel.style.display === 'none') return false;
    // Also covers a null session, and a local / JumpServer one: no remote exec
    // channel means nothing to ask.
    return hasRemoteServerInfo(this.sessionId);
  }

  private requestSysInfo(forceProcesses = false): void {
    // Gated here as well as at the timer: open() and a session switch each fire a
    // request directly, so "nothing is on screen" has to hold for every caller —
    // not only for the path that remembered to stop the timer.
    if (!this.canPoll()) return;
    const sessionId = this.sessionId;
    // canPoll() already ruled a null session out; this is for the type.
    if (!sessionId) return;
    const fileManager = DrawerManager.getFileManager(sessionId);
    // sysinfo is the gauge and goes out every tick. The process box lives in
    // this panel too, but nothing else polls it — so it still rides the same
    // tick, just far more rarely.
    fileManager?.requestServerInfo('sysinfo');
    const due = forceProcesses || this.processTick % PROCESS_EVERY_TICKS === 0;
    this.processTick++;
    if (due) fileManager?.requestServerInfo('processes');
  }

  /**
   * Nothing on screen means nothing to poll. The panel used to ignore that:
   * minimised, or with another app in front, it kept sending two SSH commands
   * every 5s for numbers nobody could see.
   *
   * The resume side deliberately does not re-ask "is the window focused?" — it
   * is driven by three independent signals (focus, visibility, any click), so
   * one missed or misreported event cannot leave the panel frozen forever.
   * `canPoll()` still reads `document.hidden`, which is the flag
   * `onHiddenChange` itself reacts to, so the two cannot disagree for long.
   */
  private onHiddenChange = (): void => {
    if (document.hidden) this.stopPolling();
    else this.resumePolling();
  };

  private onWindowBlur = (): void => {
    this.stopPolling();
  };

  private resumePolling = (): void => {
    // Not just `_open`: the signals below also fire while the dock is hidden
    // behind the home / gallery view (or its own close button), and a timer
    // restarted there polls for numbers nobody can see until the visibility
    // change that hid it fires again — which it will not, because the panel was
    // hidden by a view switch, not by the window.
    if (!this.canPoll()) return;
    // startPolling() no-ops while the timer runs, so of the signals that arrive
    // together only the first one triggers the catch-up request.
    const wasStopped = this.timer === null;
    this.startPolling();
    if (wasStopped) this.requestSysInfo(true);
  };

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

    // Polling is paused whenever there is nothing on screen to update; these are
    // the signals that say it is back (see resumePolling). Handler identities are
    // stable, so registering the same one twice would still be a no-op.
    document.addEventListener('visibilitychange', this.onHiddenChange);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('focus', this.resumePolling);
    document.addEventListener('pointerdown', this.resumePolling, true);

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
