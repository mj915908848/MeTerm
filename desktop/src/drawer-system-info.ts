/**
 * drawer-system-info.ts
 * 系统信息渲染相关：网络图表、进程列表、系统监控、格式化辅助函数
 * 从 drawer.ts 中提取，供 DrawerManagerClass 委托调用。
 */

import type { SysInfoResponse, ProcessInfo, ProcessListResponse, ServerInfoResponse, NetIfaceInfo } from './protocol';
import { t } from './i18n';
import { escapeHtml } from './status-bar';
import { cpuUsageFromTicks, formatLoadAverage, orderNicNames, pickDefaultNic, swapPercent } from './server-info-derive';

export interface NetRatePoint {
  ts: number;
  rxRate: number;
  txRate: number;
}

/** DrawerInstance 中系统信息相关的字段子集 */
export interface SysInfoFields {
  sessionId: string;
  element: HTMLDivElement;
  sysInfo: SysInfoResponse | null;
  /** Cached `ps` output; rendered by renderExpandedSysInfo, see the note there. */
  processes: ProcessInfo[] | null;
  prevNetIfaces: NetIfaceInfo[] | null;
  prevNetTimestamp: number;
  /** Previous CPU sample; `cpu_usage` is derived from the delta, see below. */
  prevCpuTicks: number[] | null;
  netHistory: Map<string, NetRatePoint[]>;
  selectedNic: string;
}

export function updateNetHistory(instance: SysInfoFields, ifaces: NetIfaceInfo[]): void {
  const now = Date.now();
  if (instance.prevNetIfaces && instance.prevNetTimestamp > 0) {
    const dt = (now - instance.prevNetTimestamp) / 1000;
    if (dt > 0) {
      for (const iface of ifaces) {
        const prev = instance.prevNetIfaces.find(p => p.name === iface.name);
        if (prev) {
          const rxRate = Math.max(0, (iface.rx_bytes - prev.rx_bytes) / dt);
          const txRate = Math.max(0, (iface.tx_bytes - prev.tx_bytes) / dt);
          const history = instance.netHistory.get(iface.name) || [];
          history.push({ ts: now, rxRate, txRate });
          if (history.length > 60) history.shift();
          instance.netHistory.set(iface.name, history);
        }
      }
    }
  }
  instance.prevNetIfaces = ifaces;
  instance.prevNetTimestamp = now;

  // Auto-select the uplink rather than interfaces[0]: a container host lists
  // docker0/veth* right next to the real NIC and the kernel's order decides
  // which one comes first. A NIC the user picked keeps winning while it exists.
  instance.selectedNic = pickDefaultNic(ifaces.map(i => i.name), instance.selectedNic);
}

export function formatUptime(seconds: number): string {
  if (seconds <= 0) return '-';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatRate(bytesPerSec: number): string {
  return formatBytes(bytesPerSec) + '/s';
}

/** Usage colour: amber above 70%, red above 90%. */
function usageClass(pct: number): string {
  return pct > 90 ? 'critical' : pct > 70 ? 'warning' : '';
}

/**
 * A thin usage bar. `percent` is optional because CPU can be genuinely unknown
 * for one poll: a Linux host sends raw counters, and the first sample of a
 * session has nothing to subtract from. Painting that as 0% would read as
 * "idle", so it renders an empty track instead.
 */
export function renderBar(percent: number | undefined): string {
  if (percent === undefined || !Number.isFinite(percent)) {
    return `<div class="si-bar"></div>`;
  }
  const pct = Math.max(0, Math.min(100, percent));
  return `<div class="si-bar ${usageClass(pct)}"><i style="width:${pct}%"></i></div>`;
}

/** Big number + unit, or `—` when the value is unknown. */
function bigPercent(percent: number | undefined): string {
  if (percent === undefined || !Number.isFinite(percent)) return '—';
  return `${Math.max(0, Math.min(100, percent)).toFixed(0)}<small>%</small>`;
}

/** Bytes without the space, for the tight corners of a tile (`1.2MB`). */
function shortBytes(bytes: number): string {
  return formatBytes(bytes).replace(' ', '');
}

/** Disk-row size: one letter unit, a decimal only below 10 (`38G`, `1.9G`). */
function sizeShort(bytes: number): string {
  if (bytes <= 0) return '0';
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 && i > 0 ? val.toFixed(1) : val.toFixed(0)}${units[i]}`;
}

/** Network tile: NIC picker, receive/transmit sparkline and current rates. */
export function renderNetTile(instance: SysInfoFields): string {
  const ifaces = instance.prevNetIfaces || [];
  if (ifaces.length === 0) return '';

  const nic = instance.selectedNic;
  const history = instance.netHistory.get(nic) || [];

  // Physical adapters first, virtual ones last (see server-info-derive.ts).
  const nicOptions = orderNicNames(ifaces.map(i => i.name)).map(name =>
    `<option value="${escapeHtml(name)}"${name === nic ? ' selected' : ''}>${escapeHtml(name)}</option>`
  ).join('');

  let lastRx = 0, lastTx = 0;
  if (history.length > 0) {
    const last = history[history.length - 1];
    lastRx = last.rxRate;
    lastTx = last.txRate;
  }

  let chartSvg = '<div class="si-spark si-spark-empty"></div>';
  if (history.length >= 2) {
    const maxPoints = 60;
    const W = 100;
    const H = 22;
    const points = history.slice(-maxPoints);
    const maxRate = Math.max(...points.map(p => Math.max(p.rxRate, p.txRate)), 1024);
    const xStep = W / (maxPoints - 1);
    const offset = maxPoints - points.length;

    const toY = (v: number) => H - (v / maxRate) * (H - 2) - 1;

    const rxPts = points.map((p, i) => `${(offset + i) * xStep},${toY(p.rxRate)}`).join(' ');
    const txPts = points.map((p, i) => `${(offset + i) * xStep},${toY(p.txRate)}`).join(' ');

    chartSvg = `<svg class="si-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polyline class="si-rx-line" points="${rxPts}" fill="none" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
      <polyline class="si-tx-line" points="${txPts}" fill="none" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  return `<div class="si-card">
    <div class="si-card-k">${t('serverInfoNetwork')}
      <select class="net-nic-select" data-session="${instance.sessionId}" aria-label="${t('serverInfoNetwork')}">${nicOptions}</select>
    </div>
    ${chartSvg}
    <div class="si-card-sub"><span class="si-rx">↓${shortBytes(lastRx)}</span> <span class="si-tx">↑${shortBytes(lastTx)}</span></div>
  </div>`;
}

/** Compact mode breakpoint — exactly 2 columns of 44px tiles + gap + padding */
const COMPACT_BREAKPOINT = 104;

// ── Standalone containers ──
//
// Sysinfo can be displayed outside the file drawer — the left-docked server
// info panel (server-info-panel.ts) registers its own container per session.
// A registered container wins over the drawer's own DOM, so a session's data
// has exactly one visible surface at a time.
const externalContainers = new Map<string, HTMLElement>();

/** Point sysinfo rendering for `sessionId` at `container` (which must contain
 *  `#server-info-<sessionId>`). */
export function registerSysInfoContainer(sessionId: string, container: HTMLElement): void {
  externalContainers.set(sessionId, container);
}

/** Hand rendering back to the drawer for `sessionId`. */
export function unregisterSysInfoContainer(sessionId: string): void {
  externalContainers.delete(sessionId);
}

function resolveSysInfoContainer(instance: SysInfoFields): HTMLElement | null {
  const external = externalContainers.get(instance.sessionId);
  if (external && external.isConnected) {
    const el = external.querySelector(`#server-info-${instance.sessionId}`) as HTMLElement | null;
    if (el) return el;
  }
  return instance.element.querySelector(`#server-info-${instance.sessionId}`) as HTMLElement | null;
}

/** Render a compact liquid-fill tile */
function renderTile(label: string, value: string, percent?: number, colorClass?: string): string {
  if (percent !== undefined) {
    const pct = Math.max(0, Math.min(100, percent));
    const cls = pct > 90 ? 'critical' : pct > 70 ? 'warning' : '';
    return `<div class="si-tile si-tile-gauge ${cls}" title="${label}: ${value}">
      <div class="si-tile-fill" style="height:${pct}%"></div>
      <span class="si-tile-label">${label}</span>
      <span class="si-tile-value">${value}</span>
    </div>`;
  }
  return `<div class="si-tile ${colorClass || ''}" title="${value}">
    <span class="si-tile-label">${label}</span>
    <span class="si-tile-value">${value}</span>
  </div>`;
}

/** Render compact tiles view (narrow sidebar) */
function renderCompactSysInfo(instance: SysInfoFields, serverInfoEl: HTMLElement): void {
  const info = instance.sysInfo;
  if (!info) return;
  const memPct = (info.mem_total ?? 0) > 0 ? ((info.mem_used ?? 0) / info.mem_total) * 100 : 0;

  // Net rates
  let rxRate = 0;
  const nic = instance.selectedNic;
  const history = instance.netHistory.get(nic);
  if (history && history.length > 0) {
    rxRate = history[history.length - 1].rxRate;
  }

  const diskTiles = (info.disks || []).map(d => {
    const pct = d.total > 0 ? (d.used / d.total) * 100 : 0;
    return renderTile(escapeHtml(String(d.mount)), `${pct.toFixed(0)}%`, pct);
  }).join('');

  // No connection info in compact mode — just tiles in a single column
  serverInfoEl.innerHTML = `
    <div class="si-tiles">
      ${renderTile('CPU', info.cpu_usage === undefined ? '—' : `${info.cpu_usage.toFixed(0)}%`, info.cpu_usage ?? 0)}
      ${renderTile('MEM', `${memPct.toFixed(0)}%`, memPct)}
      ${diskTiles}
      ${renderTile('UP', formatUptime(info.uptime_seconds ?? 0))}
      ${renderTile('NET', `↓${formatRate(rxRate).replace('/s', '')}`)}
    </div>
  `;

  serverInfoEl.classList.add('server-info-compact');
  serverInfoEl.classList.remove('server-info-expanded');
}

/**
 * Render full expanded view (wide sidebar) — the "dashboard" layout:
 *
 *   who line   user@host, then OS · arch · uptime
 *   tiles      CPU, memory, load, network (2×2, the numbers people glance at)
 *   disks      one row per mount, swap last
 *   processes  command / CPU / memory
 */
function renderExpandedSysInfo(instance: SysInfoFields, serverInfoEl: HTMLElement): void {
  const info = instance.sysInfo;
  if (!info) return;
  const memPercent = info.mem_total > 0 ? (info.mem_used / info.mem_total) * 100 : 0;
  const swapTotal = info.swap_total ?? 0;
  const swapUsed = info.swap_used ?? 0;

  // The host line comes from the panel (server-info-panel.ts connBlock).
  const existingConn = serverInfoEl.querySelector('.server-info-conn');
  const connHtml = existingConn ? existingConn.outerHTML : '';

  const os = escapeHtml(String(info.os_name || info.os_type));
  const kernel = `${escapeHtml(String(info.kernel))} ${escapeHtml(String(info.arch))}`;
  const uptime = formatUptime(info.uptime_seconds ?? 0);
  const whoSub = `<div class="si-who-sub" title="${kernel}">${os} · ${t('serverInfoUptime')} ${uptime}</div>`;

  const cpuTile = `<div class="si-card" title="${escapeHtml(String(info.cpu_model ?? ''))}">
    <div class="si-card-k">${t('serverInfoCPU')}<span>${escapeHtml(String(info.cpu_cores ?? 0))} ${t('serverInfoCores')}</span></div>
    <div class="si-card-big">${bigPercent(info.cpu_usage)}</div>
    ${renderBar(info.cpu_usage)}
  </div>`;

  const memTile = `<div class="si-card">
    <div class="si-card-k">${t('serverInfoMemory')}</div>
    <div class="si-card-big">${bigPercent(memPercent)}</div>
    ${renderBar(memPercent)}
    <div class="si-card-sub">${formatBytes(info.mem_used ?? 0)} / ${formatBytes(info.mem_total ?? 0)}</div>
  </div>`;

  // Older remote hosts (and the local fallback) report no load average: the
  // tile shows swap instead, so the grid stays 2×2.
  const loads = formatLoadAverage(info.load_avg).split(', ').filter(Boolean);
  const loadTile = loads.length > 0
    ? `<div class="si-card">
      <div class="si-card-k">${t('serverInfoLoad')}</div>
      <div class="si-card-big">${loads[0]}</div>
      ${loads.length >= 3 ? `<div class="si-card-sub" title="5m ${loads[1]} · 15m ${loads[2]}">${loads[1]} · ${loads[2]}</div>` : ''}
    </div>`
    : `<div class="si-card">
      <div class="si-card-k">${t('serverInfoSwap')}</div>
      <div class="si-card-big">${bigPercent(swapPercent(swapTotal, swapUsed))}</div>
      ${renderBar(swapPercent(swapTotal, swapUsed))}
    </div>`;

  const diskRow = (label: string, used: number, total: number): string => {
    const pct = total > 0 ? (used / total) * 100 : 0;
    return `<div class="si-row" title="${label}: ${formatBytes(used)} / ${formatBytes(total)}">
      <span class="si-row-k">${label}</span>
      ${renderBar(pct)}
      <span class="si-row-v">${sizeShort(used)} / ${sizeShort(total)}</span>
    </div>`;
  };
  const diskRows = (info.disks || []).map(d => diskRow(escapeHtml(String(d.mount)), d.used, d.total)).join('')
    + (swapTotal > 0 && loads.length > 0 ? diskRow(t('serverInfoSwap'), swapUsed, swapTotal) : '');

  serverInfoEl.innerHTML = `
    <div class="si-who">${connHtml}${whoSub}</div>
    <div class="si-grid">
      ${cpuTile}
      ${memTile}
      ${loadTile}
      ${renderNetTile(instance)}
    </div>
    ${diskRows ? `<div class="si-sec">${t('serverInfoDisk')}</div>${diskRows}` : ''}
    ${renderProcessBox(instance)}
  `;

  serverInfoEl.classList.add('server-info-expanded');
  serverInfoEl.classList.remove('server-info-compact');

  // Bind NIC selector
  const nicSelect = serverInfoEl.querySelector(`.net-nic-select[data-session="${instance.sessionId}"]`) as HTMLSelectElement;
  if (nicSelect) {
    nicSelect.addEventListener('change', () => {
      instance.selectedNic = nicSelect.value;
      renderSysInfo(instance);
    });
  }
}

/**
 * `%CPU`/`%MEM` for one row — or `—` when the host could not supply it.
 *
 * The Rust side sends `null` for a column the host has no way to report (BusyBox
 * `ps` has neither), rather than a `0` that would read as "measured, and idle" on
 * every single row. `—` is what the rest of this panel already uses for a value
 * it does not have. `high-usage` only means something for a real number, so it
 * stays off in that case.
 */
function processMetric(value: number | null | undefined): { text: string; high: boolean } {
  if (typeof value !== 'number') return { text: '—', high: false };
  return { text: value.toFixed(1), high: value > 50 };
}

/**
 * The process list used to live in the file drawer's own tab; it now renders as
 * the last section of the panel, under the disks.
 *
 * It is rendered from `instance.processes` as part of the sysinfo template
 * rather than into its own target: the two polls (sysinfo, processes) land out
 * of step, and a separate DOM node would be wiped by the next sysinfo render —
 * the rows would flicker every 5s. One owner for the whole block, no flicker.
 *
 * Three columns only. The panel is 280px by default, and PID/user/etime would
 * leave the command column a few characters wide.
 */
function renderProcessBox(instance: SysInfoFields): string {
  const procs = instance.processes ?? [];
  if (procs.length === 0) return '';
  const rows = procs.map(p => {
    const cmd = escapeHtml(String(p.command));
    const mem = processMetric(p.mem);
    const cpu = processMetric(p.cpu);
    return `<div class="si-proc">
      <span class="si-proc-cmd" title="${cmd}">${cmd}</span>
      <span class="si-proc-num${cpu.high ? ' high-usage' : ''}">${cpu.text}</span>
      <span class="si-proc-num${mem.high ? ' high-usage' : ''}">${mem.text}</span>
    </div>`;
  }).join('');

  return `<div class="si-sec">${t('serverInfoProcesses')}</div>
    <div class="si-proc si-proc-head">
      <span class="si-proc-cmd">${t('processColCommand')}</span>
      <span class="si-proc-num">${t('processColCPU')}</span>
      <span class="si-proc-num">${t('processColMem')}</span>
    </div>
    <div class="si-proc-list">${rows}</div>`;
}

export function renderSysInfo(instance: SysInfoFields): void {
  const info = instance.sysInfo;
  if (!info) return;

  const serverInfoEl = resolveSysInfoContainer(instance);
  if (!serverInfoEl) return;

  // Determine compact vs expanded based on the surface that hosts the panel
  // (the standalone left-docked server-info panel is the only remaining host).
  const surface = serverInfoEl.closest('.server-info-panel-body') as HTMLElement | null;
  const isCompact = surface ? surface.offsetWidth < COMPACT_BREAKPOINT : false;

  if (isCompact) {
    renderCompactSysInfo(instance, serverInfoEl);
  } else {
    renderExpandedSysInfo(instance, serverInfoEl);
  }

  // Tooltip on truncated text
  serverInfoEl.querySelectorAll('.server-info-value, .si-who-sub, .si-row-k').forEach((el) => {
    el.addEventListener('mouseenter', () => {
      const htmlEl = el as HTMLElement;
      if (htmlEl.scrollWidth > htmlEl.clientWidth) {
        htmlEl.title = htmlEl.textContent || '';
      } else {
        htmlEl.removeAttribute('title');
      }
    });
  });
}

export function handleServerInfoResponse(instance: SysInfoFields, data: ServerInfoResponse): void {
  if (data.type === 'sysinfo') {
    const sysInfo = data as SysInfoResponse;
    // Pair this sample with the previous one to get a real interval average —
    // the remote script no longer sleeps a second to take its own pair (see
    // cpuUsageFromTicks). A host that reports a direct percentage (macOS `top`)
    // has no cpu_ticks and keeps its own value.
    const usage = cpuUsageFromTicks(instance.prevCpuTicks, sysInfo.cpu_ticks);
    instance.prevCpuTicks = sysInfo.cpu_ticks ?? null;
    if (usage !== null) sysInfo.cpu_usage = usage;
    else if (sysInfo.cpu_ticks) sysInfo.cpu_usage = undefined;
    instance.sysInfo = sysInfo;
    updateNetHistory(instance, sysInfo.net_ifaces || []);
    renderSysInfo(instance);
  } else if (data.type === 'processes') {
    // Cached and re-rendered as a whole: the box lives inside the sysinfo
    // template, so writing the rows into their own node would be undone by the
    // next sysinfo tick (see renderProcessBox).
    instance.processes = (data as ProcessListResponse).processes;
    renderSysInfo(instance);
  }
}
