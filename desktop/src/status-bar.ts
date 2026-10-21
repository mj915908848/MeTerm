import type { SessionStatus } from './terminal';

// ─── Data Structures ─────────────────────────────────────────────

export interface TransferInfo {
  direction: 'upload' | 'download' | 'mixed';
  fileCount: number;
  progress: number; // 0-100
}

interface CapsuleState {
  connectionStatus: SessionStatus | 'error';
  connectionLabel: string;
  latencyMs: number | null;
  sessionCount: number;
  transfer: TransferInfo | null;
  aiActive: boolean;
  /** Pane number of the currently-focused pane, or null when the
   *  active tab has only one pane (hidden in that case). */
  paneNumber: number | null;
  /** Total pane count of the active tab (for the "N/M" suffix). */
  paneTotal: number;
}

// ─── Helpers ─────────────────────────────────────────────────────

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

// ─── SVG Icons (12×12 inline, stroke style) ─────────────────────

const SVG_ATTR = 'width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

const svgIcons = {
  /** ⚡ latency / bolt */
  bolt: `<svg ${SVG_ATTR}><path d="M9 1.5L4 9h4l-1 5.5L12 7H8z"/></svg>`,
  /** ⩉ sessions / windows grid */
  sessions: `<svg ${SVG_ATTR}><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1"/><rect x="9" y="9" width="5.5" height="5.5" rx="1"/></svg>`,
  /** ↑ upload arrow */
  upload: `<svg ${SVG_ATTR}><path d="M8 13V3"/><path d="M3.5 7.5L8 3l4.5 4.5"/></svg>`,
  /** ↓ download arrow */
  download: `<svg ${SVG_ATTR}><path d="M8 3v10"/><path d="M3.5 8.5L8 13l4.5-4.5"/></svg>`,
  /** ↕ bidirectional transfer */
  transfer: `<svg ${SVG_ATTR}><path d="M5 13V3"/><path d="M2.5 5.5L5 3l2.5 2.5"/><path d="M11 3v10"/><path d="M8.5 10.5L11 13l2.5-2.5"/></svg>`,
  /** AI sparkle */
  ai: `<svg ${SVG_ATTR}><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/><path d="M3.5 3.5l2 2M10.5 10.5l2 2M10.5 3.5l-2 2M3.5 10.5l2-2"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/></svg>`,
} as const;

// ─── StatusBar Class ─────────────────────────────────────────────

class StatusBarClass {
  private container: HTMLDivElement | null = null;
  private leftZone: HTMLDivElement | null = null;
  private rightZone: HTMLDivElement | null = null;

  // Capsule DOM elements (null means not yet created or removed)
  private connectionCapsule: HTMLDivElement | null = null;
  private latencyCapsule: HTMLDivElement | null = null;
  private sessionsCapsule: HTMLDivElement | null = null;
  private transferCapsule: HTMLDivElement | null = null;
  private aiCapsule: HTMLDivElement | null = null;

  // Active transfer tracking
  private activeTransfers = new Map<string, { type: 'upload' | 'download'; progress: number; status: string }>();

  // OSC 9;4 progress layer
  private progressLayer: HTMLDivElement | null = null;
  private progressFill: HTMLDivElement | null = null;

  // Timers
  private transferHideTimer: ReturnType<typeof setTimeout> | null = null;
  private aiExitTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether the bar is on screen right now. Written only by
   *  updateVisibility(), read by doPing()/the pong listener to decide
   *  whether a latency reading is worth taking at all. */
  private visible = false;

  // Saved event listener references for cleanup
  private initialized = false;
  private transferListener: EventListener | null = null;
  private aiListener: EventListener | null = null;
  private pongListener: EventListener | null = null;

  private paneCapsule: HTMLDivElement | null = null;

  private state: CapsuleState = {
    connectionStatus: 'disconnected',
    connectionLabel: 'Disconnected',
    latencyMs: null,
    sessionCount: 0,
    transfer: null,
    aiActive: false,
    paneNumber: null,
    paneTotal: 0,
  };

  // ── Initialization ──────────────────────────────────────────

  init(container: HTMLDivElement): void {
    // Guard against duplicate initialization — clean up first
    if (this.initialized) {
      this.destroy();
    }

    this.container = container;
    this.container.innerHTML = '';

    this.leftZone = document.createElement('div');
    this.leftZone.className = 'status-left';

    const spacer = document.createElement('div');
    spacer.className = 'status-spacer';

    this.rightZone = document.createElement('div');
    this.rightZone.className = 'status-right';

    this.container.appendChild(this.leftZone);
    this.container.appendChild(spacer);
    this.container.appendChild(this.rightZone);

    // Connection capsule is always visible
    this.renderConnectionCapsule();
    this.listenForTransfers();
    this.listenForAI();
    this.initialized = true;
    this.updateVisibility();
  }

  // ── Public API ──────────────────────────────────────────────

  setConnection(status: SessionStatus | 'error', label?: string): void {
    this.state.connectionStatus = status;
    this.state.connectionLabel = label ?? this.defaultLabel(status);
    this.renderConnectionCapsule();
    this.renderLatencyCapsule();
    this.updateVisibility();
  }

  setLatency(ms: number | null): void {
    this.state.latencyMs = ms;
    this.renderLatencyCapsule();
  }

  /**
   * Phase 2: show the currently-focused pane number for the active
   * tab. Pass (null, 0) to clear. The capsule is automatically
   * hidden when total ≤ 1 (single-pane tabs don't need it).
   */
  setPane(paneNumber: number | null, total: number): void {
    this.state.paneNumber = paneNumber;
    this.state.paneTotal = total;
    this.renderPaneCapsule();
  }

  setSessionCount(count: number): void {
    this.state.sessionCount = count;
    this.renderSessionsCapsule();
  }

  setTransfer(info: TransferInfo | null): void {
    // Clear any pending hide timer
    if (this.transferHideTimer !== null) {
      clearTimeout(this.transferHideTimer);
      this.transferHideTimer = null;
    }

    if (info === null || info.progress >= 100) {
      // Transfer complete or cleared — keep visible for 2 seconds, then fade out
      if (info !== null && info.progress >= 100) {
        this.state.transfer = info;
        this.renderTransferCapsule();
      }
      this.transferHideTimer = setTimeout(() => {
        this.transferHideTimer = null;
        this.state.transfer = null;
        this.removeCapsuleAnimated(this.transferCapsule, () => {
          this.transferCapsule = null;
        });
      }, info !== null && info.progress >= 100 ? 2000 : 0);
    } else {
      this.state.transfer = info;
      this.renderTransferCapsule();
    }
  }

  setAIActive(active: boolean): void {
    // Clear any pending exit timer
    if (this.aiExitTimer !== null) {
      clearTimeout(this.aiExitTimer);
      this.aiExitTimer = null;
    }

    if (active) {
      this.state.aiActive = true;
      this.renderAICapsule();
    } else {
      // Delayed exit — wait 300ms before removing
      this.aiExitTimer = setTimeout(() => {
        this.aiExitTimer = null;
        this.state.aiActive = false;
        this.removeCapsuleAnimated(this.aiCapsule, () => {
          this.aiCapsule = null;
        });
      }, 300);
    }
  }

  setProgress(progress: { state: number; percent: number } | null): void {
    if (!this.container) return;

    if (!progress || progress.state === 0) {
      if (this.progressLayer) {
        this.progressLayer.remove();
        this.progressLayer = null;
        this.progressFill = null;
      }
      return;
    }

    if (!this.progressLayer) {
      this.progressLayer = document.createElement('div');
      this.progressLayer.className = 'osc-progress-layer';
      this.progressFill = document.createElement('div');
      this.progressFill.className = 'osc-progress-fill';
      this.progressLayer.appendChild(this.progressFill);
      this.container.insertBefore(this.progressLayer, this.container.firstChild);
    }

    const fill = this.progressFill!;
    fill.classList.remove('normal', 'error', 'indeterminate');
    if (progress.state === 1) {
      fill.classList.add('normal');
      fill.style.width = `${progress.percent}%`;
    } else if (progress.state === 2) {
      fill.classList.add('error');
      fill.style.width = `${progress.percent}%`;
    } else if (progress.state === 3) {
      fill.classList.add('indeterminate');
      fill.style.width = '100%';
    }
  }

  setError(message: string): void {
    this.setConnection('error', message);
  }

  // ── Tooltip ─────────────────────────────────────────────────

  getConnectionTooltip(): string {
    const parts: string[] = [];
    parts.push(`Status: ${this.state.connectionLabel}`);
    if (this.state.latencyMs !== null) {
      parts.push(`Latency: ${this.state.latencyMs}ms`);
    }
    if (this.state.sessionCount > 1) {
      parts.push(`Sessions: ${this.state.sessionCount}`);
    }
    return parts.join('\n');
  }

  // ── Rendering ───────────────────────────────────────────────

  private renderConnectionCapsule(): void {
    if (!this.leftZone) return;

    if (!this.connectionCapsule) {
      this.connectionCapsule = document.createElement('div');
      this.connectionCapsule.className = 'status-capsule capsule-connection';
      this.connectionCapsule.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('status-bar-reconnect'));
      });
      this.leftZone.insertBefore(
        this.connectionCapsule,
        this.leftZone.firstChild
      );
    }

    const status = this.state.connectionStatus;
    // Map 'notfound' to 'disconnected' for CSS class since they share the same styling
    const dotClass = status === 'notfound' ? 'disconnected' : status;
    const label = escapeHtml(this.state.connectionLabel);
    this.connectionCapsule.innerHTML =
      `<span class="status-dot ${dotClass}"></span>` +
      `<span>${label}</span>`;
    this.connectionCapsule.title = this.getConnectionTooltip();
  }

  private renderPaneCapsule(): void {
    if (!this.leftZone) return;
    const { paneNumber, paneTotal } = this.state;
    // Hide when there's no multi-pane situation to describe.
    if (!paneNumber || paneTotal < 2) {
      if (this.paneCapsule) {
        this.removeCapsuleAnimated(this.paneCapsule, () => {
          this.paneCapsule = null;
        });
      }
      return;
    }
    if (!this.paneCapsule) {
      this.paneCapsule = document.createElement('div');
      this.paneCapsule.className = 'status-capsule capsule-pane';
      this.addCapsuleAnimated(this.paneCapsule);
      // Insert after the connection capsule, before latency.
      const anchor = this.connectionCapsule?.nextSibling ?? null;
      this.leftZone.insertBefore(this.paneCapsule, anchor);
    }
    // Use circled numbers ①..⑳ when possible, else Pane N.
    const glyph = paneNumber >= 1 && paneNumber <= 20
      ? String.fromCodePoint(0x245F + paneNumber)
      : String(paneNumber);
    this.paneCapsule.innerHTML = `<span class="pane-glyph">${glyph}</span><span>Pane · ${paneTotal}</span>`;
    this.paneCapsule.title = `Pane ${paneNumber} of ${paneTotal}`;
  }

  private renderLatencyCapsule(): void {
    if (!this.leftZone) return;

    const isConnected =
      this.state.connectionStatus === 'connected';

    if (!isConnected || this.state.latencyMs === null) {
      if (this.latencyCapsule) {
        this.removeCapsuleAnimated(this.latencyCapsule, () => {
          this.latencyCapsule = null;
        });
      }
      return;
    }

    const ms = this.state.latencyMs;
    const qualityClass = ms <= 30 ? 'good' : ms <= 100 ? 'medium' : 'bad';

    if (!this.latencyCapsule) {
      this.latencyCapsule = document.createElement('div');
      this.latencyCapsule.className = 'status-capsule capsule-latency';
      this.addCapsuleAnimated(this.latencyCapsule);

      // Insert after connection capsule
      const afterConnection = this.connectionCapsule?.nextSibling ?? null;
      this.leftZone.insertBefore(this.latencyCapsule, afterConnection);
    }

    this.latencyCapsule.innerHTML =
      `<span class="latency-value ${qualityClass}">${svgIcons.bolt} ${ms}ms</span>`;
  }

  private renderSessionsCapsule(): void {
    if (!this.leftZone) return;

    if (this.state.sessionCount <= 1) {
      if (this.sessionsCapsule) {
        this.removeCapsuleAnimated(this.sessionsCapsule, () => {
          this.sessionsCapsule = null;
        });
      }
      return;
    }

    if (!this.sessionsCapsule) {
      this.sessionsCapsule = document.createElement('div');
      this.sessionsCapsule.className = 'status-capsule capsule-sessions';
      this.addCapsuleAnimated(this.sessionsCapsule);
      this.leftZone.appendChild(this.sessionsCapsule);
    }

    this.sessionsCapsule.innerHTML =
      `<span>${svgIcons.sessions} ${this.state.sessionCount}</span>`;
  }

  private renderTransferCapsule(): void {
    if (!this.rightZone || !this.state.transfer) return;

    const t = this.state.transfer;
    const arrow =
      t.direction === 'upload' ? svgIcons.upload :
      t.direction === 'download' ? svgIcons.download : svgIcons.transfer;
    if (!this.transferCapsule) {
      this.transferCapsule = document.createElement('div');
      this.transferCapsule.className = 'status-capsule capsule-transfer';
      this.addCapsuleAnimated(this.transferCapsule);
      this.rightZone.insertBefore(
        this.transferCapsule,
        this.rightZone.firstChild
      );
    }

    const pct = Math.round(t.progress);

    // In-place update: 保持 DOM 元素不重建，CSS transition 处理动画
    const existingFill = this.transferCapsule.querySelector('.transfer-progress-fill') as HTMLElement | null;
    const existingText = this.transferCapsule.querySelector('span') as HTMLElement | null;
    if (existingFill && existingText) {
      existingText.innerHTML = `${arrow} ${t.fileCount} file${t.fileCount !== 1 ? 's' : ''} ${pct}%`;
      existingFill.style.width = `${t.progress}%`;
    } else {
      this.transferCapsule.innerHTML =
        `<span>${arrow} ${t.fileCount} file${t.fileCount !== 1 ? 's' : ''} ${pct}%</span>` +
        `<div class="transfer-progress-bar"><div class="transfer-progress-fill" style="width:${t.progress}%"></div></div>`;
    }
    this.updateVisibility();
  }

  private renderAICapsule(): void {
    if (!this.rightZone) return;

    if (!this.state.aiActive) return;

    if (!this.aiCapsule) {
      this.aiCapsule = document.createElement('div');
      this.aiCapsule.className = 'status-capsule capsule-ai';
      this.addCapsuleAnimated(this.aiCapsule);
      this.rightZone.appendChild(this.aiCapsule);
    }

    this.aiCapsule.innerHTML =
      `<span class="ai-dot"></span>${svgIcons.ai}<span>AI</span>`;
    this.updateVisibility();
  }

  // ── Capsule Lifecycle Animations ────────────────────────────

  private addCapsuleAnimated(el: HTMLDivElement): void {
    el.classList.add('capsule-entering');
    const onEnd = () => {
      el.classList.remove('capsule-entering');
      el.removeEventListener('animationend', onEnd);
    };
    el.addEventListener('animationend', onEnd);
  }

  private removeCapsuleAnimated(
    el: HTMLDivElement | null,
    cleanup: () => void
  ): void {
    if (!el) {
      cleanup();
      return;
    }
    el.classList.add('capsule-exiting');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('animationend', onEnd);
      el.remove();
      cleanup();
      this.updateVisibility();
    };
    const onEnd = () => finish();
    el.addEventListener('animationend', onEnd);
    // Safety net: clean up if animationend never fires (e.g. element not in DOM)
    setTimeout(finish, 300);
  }

  /**
   * The bar is a readout of *what is happening right now*, not a permanent
   * fixture: it is on screen while something is in flight or wrong —
   * connecting, reconnecting, a failure, a file transfer, a running AI turn —
   * and retracts to 0 the rest of the time. A healthy session that just sits
   * there is not an event, so its 24px row goes back to #app.
   *
   * Collapsing is also the signal to stop *measuring*: the 5s ping only exists
   * to feed the latency capsule next to the connection label, so with the bar
   * away there is nothing to ping for (this also keeps us from opening an SSH
   * channel on the remote host every 5s just to update a number nobody sees).
   * The samples and the last value are dropped with it, so the capsule can
   * never flash a previous session's number on the way back.
   */
  private updateVisibility(): void {
    if (!this.container) return;
    const s = this.state;
    const show =
      s.connectionStatus === 'connecting' ||
      s.connectionStatus === 'reconnecting' ||
      s.connectionStatus === 'error' ||
      s.transfer != null ||
      s.aiActive ||
      this.activeTransfers.size > 0;

    const wasVisible = this.visible;
    this.visible = show;

    this.container.classList.toggle('status-collapsed', !show);
    // Also collapse the #app grid row so the reserved 24px space is reclaimed.
    document.getElementById('app')?.classList.toggle('app-status-collapsed', !show);

    if (!show) {
      // Nothing on screen to describe — stop accumulating latency (the 5s
      // interval keeps ticking but doPing() turns into a no-op).
      this.latencyHistory = [];
      if (this.state.latencyMs !== null) this.setLatency(null);
      return;
    }

    // Coming back on screen: don't make the user wait a whole ping interval
    // before the first reading appears.
    if (!wasVisible) this.doPing();
  }

  // ── Latency Monitor ────────────────────────────────────────

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private latencyHistory: number[] = [];
  private getActiveSessionId: (() => string | null) | null = null;
  private sendPingFn: ((sessionId: string) => void) | null = null;

  startLatencyMonitor(
    getActiveSessionId: () => string | null,
    sendPing: (sessionId: string) => void,
  ): void {
    this.getActiveSessionId = getActiveSessionId;
    this.sendPingFn = sendPing;

    // Remove previous pong listener if any
    if (this.pongListener) {
      document.removeEventListener('status-bar-pong', this.pongListener);
    }

    this.pongListener = ((e: CustomEvent<{ sessionId: string; rtt: number }>) => {
      // A pong can be in flight (or be triggered by input on another terminal)
      // at the moment the bar collapses. updateVisibility() has just dropped
      // the window — letting this one back in would leave a stale number
      // waiting to be shown the next time the bar reappears.
      if (!this.visible) return;
      this.latencyHistory.push(e.detail.rtt);
      if (this.latencyHistory.length > 5) this.latencyHistory.shift();
      const avg = Math.round(this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length);
      this.setLatency(avg);
    }) as EventListener;
    document.addEventListener('status-bar-pong', this.pongListener);

    this.pingTimer = setInterval(() => {
      this.doPing();
    }, 5000);

    // First ping after short delay
    setTimeout(() => this.doPing(), 500);
  }

  private doPing(): void {
    if (!this.getActiveSessionId || !this.sendPingFn) return;
    // The bar is not on screen → the capsule is not on screen → there is
    // nothing to measure. (Keepalive is not this ping's job: TerminalRegistry
    // pings every live terminal on its own 30s timer so background tabs don't
    // get dropped by the server's 90s idle rule.)
    if (!this.visible) return;
    const sessionId = this.getActiveSessionId();
    if (sessionId) {
      this.sendPingFn(sessionId);
    }
  }

  stopLatencyMonitor(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongListener) {
      document.removeEventListener('status-bar-pong', this.pongListener);
      this.pongListener = null;
    }
    this.latencyHistory = [];
    this.setLatency(null);
  }

  // ── Transfer Event Listener ────────────────────────────────

  private listenForTransfers(): void {
    this.transferListener = ((e: CustomEvent<{
      sessionId: string; id: string; type: 'upload' | 'download'; progress: number; status: string;
    }>) => {
      const { id, type, progress, status } = e.detail;
      const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
      if (isTerminal) {
        this.activeTransfers.delete(id);
      } else {
        this.activeTransfers.set(id, { type, progress, status });
      }

      if (this.activeTransfers.size === 0) {
        if (status === 'cancelled' || status === 'failed') {
          // Cancelled/failed: remove capsule immediately, no "100%" flash
          this.setTransfer(null);
        } else {
          // Completed: show 100% for 2s then fade out
          this.setTransfer({ direction: type, fileCount: 0, progress: 100 });
        }
      } else {
        let uploads = 0, downloads = 0, totalProgress = 0;
        this.activeTransfers.forEach((t) => {
          if (t.type === 'upload') uploads++;
          else downloads++;
          totalProgress += t.progress;
        });
        const direction: 'upload' | 'download' | 'mixed' = uploads > 0 && downloads > 0 ? 'mixed' : uploads > 0 ? 'upload' : 'download';
        const avgProgress = totalProgress / this.activeTransfers.size;
        this.setTransfer({ direction, fileCount: this.activeTransfers.size, progress: avgProgress });
      }
    }) as EventListener;
    document.addEventListener('status-bar-transfer', this.transferListener);
  }

  // ── AI Event Listener ──────────────────────────────────────

  private listenForAI(): void {
    this.aiListener = ((e: CustomEvent<{ active: boolean }>) => {
      this.setAIActive(e.detail.active);
    }) as EventListener;
    document.addEventListener('status-bar-ai', this.aiListener);
  }

  // ── Teardown ────────────────────────────────────────────────

  destroy(): void {
    this.stopLatencyMonitor();

    if (this.transferListener) {
      document.removeEventListener('status-bar-transfer', this.transferListener);
      this.transferListener = null;
    }
    if (this.aiListener) {
      document.removeEventListener('status-bar-ai', this.aiListener);
      this.aiListener = null;
    }

    if (this.transferHideTimer !== null) {
      clearTimeout(this.transferHideTimer);
      this.transferHideTimer = null;
    }
    if (this.aiExitTimer !== null) {
      clearTimeout(this.aiExitTimer);
      this.aiExitTimer = null;
    }

    if (this.progressLayer) {
      this.progressLayer.remove();
      this.progressLayer = null;
      this.progressFill = null;
    }

    this.activeTransfers.clear();
    this.connectionCapsule = null;
    this.latencyCapsule = null;
    this.sessionsCapsule = null;
    this.transferCapsule = null;
    this.aiCapsule = null;
    this.leftZone = null;
    this.rightZone = null;

    if (this.container) {
      this.container.innerHTML = '';
      this.container = null;
    }
    this.initialized = false;
  }

  // ── Utilities ───────────────────────────────────────────────

  private defaultLabel(status: SessionStatus | 'error'): string {
    switch (status) {
      case 'connecting':
        return 'Connecting';
      case 'connected':
        return 'Connected';
      case 'reconnecting':
        return 'Reconnecting';
      case 'ended':
        return 'Ended';
      case 'notfound':
        return 'Not Found';
      case 'disconnected':
        return 'Disconnected';
      case 'error':
        return 'Error';
    }
  }
}

// ─── Singleton Export ────────────────────────────────────────────

export const StatusBar = new StatusBarClass();
