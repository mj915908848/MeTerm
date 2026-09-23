/**
 * server-info-derive.ts — pure derivation helpers for the server-info panel.
 *
 * Zero imports on purpose: drawer-system-info.ts pulls in the i18n and
 * status-bar modules, which do not resolve under `node --test`, so anything
 * that deserves a guard test has to live here.
 */

/**
 * The 1/5/15-minute load averages as `uptime` prints them: `0.39, 0.15, 0.09`.
 * Returns '' when the host reported nothing, so the caller can drop the row.
 */
export function formatLoadAverage(loads: number[] | undefined): string {
  const list = (loads ?? []).slice(0, 3);
  if (list.length === 0) return '';
  return list.map((v) => (Number.isFinite(v) ? v.toFixed(2) : '0.00')).join(', ');
}

/**
 * Swap usage as a percentage. A host with no swap at all reports
 * `swap_total: 0` — that is 0%, not a division by zero and not NaN.
 */
export function swapPercent(total: number | undefined, used: number | undefined): number {
  const t = total ?? 0;
  if (!(t > 0)) return 0;
  const u = Math.max(0, used ?? 0);
  return Math.min(100, (u / t) * 100);
}

export type NicKind = 'physical' | 'other' | 'virtual';

/** Physical uplink names, by the conventions Linux and macOS use. */
const PHYSICAL_NIC = /^(?:en|eth|em|wl|ww|bond|team)/;

/**
 * Devices a container/VM host reports next to its real uplink. `br-` (docker's
 * bridge) is kept distinct from `br0`, which is often the machine's own bridge.
 */
const VIRTUAL_NIC =
  /^(?:lo|docker|veth|virbr|br-|cni|flannel|cali|kube|nodelocaldns|tun|tap|zt|wg|utun|awdl|llw|dummy)/;

export function nicKind(name: string): NicKind {
  const n = name.trim().toLowerCase();
  if (VIRTUAL_NIC.test(n)) return 'virtual';
  if (PHYSICAL_NIC.test(n)) return 'physical';
  return 'other';
}

const NIC_RANK: Record<NicKind, number> = { physical: 0, other: 1, virtual: 2 };

/**
 * Sort interface names for the dropdown: physical adapters first (ens192, eth0,
 * enp3s0 …), then the ones we cannot classify, then virtual/tunnel devices.
 * `Array.prototype.sort` is stable, so names keep the kernel's order inside
 * each rank.
 */
export function orderNicNames(names: string[]): string[] {
  return [...names].sort((a, b) => NIC_RANK[nicKind(a)] - NIC_RANK[nicKind(b)]);
}

/**
 * The interface the chart should start on. The kernel's own order puts
 * whatever it enumerates first up top — usually fine, but on a container host
 * that can be `docker0`, so the default has to be chosen rather than taken.
 * A NIC the user picked by hand wins for as long as it still exists.
 */
export function pickDefaultNic(names: string[], current?: string): string {
  if (current && names.includes(current)) return current;
  return orderNicNames(names)[0] ?? '';
}

/**
 * Indexes inside the `/proc/stat` counter vector. Busy is `user + system`, the
 * same pair the shell this replaced summed (`u = $1 + $3` of
 * `user nice system idle iowait irq softirq`).
 */
const CPU_USER = 0;
const CPU_SYSTEM = 2;
const CPU_COUNTERS = 7;

/**
 * CPU busy share between two consecutive `/proc/stat` samples, in percent.
 *
 * The remote script used to `sleep 1` and take both readings itself, which held
 * its SSH exec channel open for a whole second every poll; the panel now pairs
 * one poll's sample with the previous one. Same arithmetic, but the window is a
 * real poll interval (5s) instead of one second, so the number is an interval
 * average rather than a jittery instantaneous reading.
 *
 * The definition of "busy" is deliberately unchanged from the script: only
 * `user + system` counts, and `nice`/`irq`/`softirq`/`iowait` sit on the idle
 * side of the ratio. Changing it would silently redefine a number an operator
 * already reads off the panel.
 *
 * Returns null when there is nothing to subtract: no previous sample (the first
 * poll after a session opens — the panel shows a placeholder rather than a
 * confident 0%), a counter vector of unexpected length, or a counter that went
 * backwards (reboot, or a wrap) — all cases where any percentage derived from
 * it would be fiction.
 */
export function cpuUsageFromTicks(
  prev: number[] | null | undefined,
  cur: number[] | null | undefined,
): number | null {
  if (!prev || !cur || prev.length !== CPU_COUNTERS || cur.length !== CPU_COUNTERS) {
    return null;
  }
  let busy = 0;
  let total = 0;
  for (let i = 0; i < CPU_COUNTERS; i++) {
    const delta = cur[i] - prev[i];
    if (!Number.isFinite(delta) || delta < 0) return null;
    total += delta;
    if (i === CPU_USER || i === CPU_SYSTEM) busy += delta;
  }
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, (busy / total) * 100));
}
