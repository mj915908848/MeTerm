/**
 * tab-layout.ts — Width allocation for the title-bar tab strip.
 *
 * Sizing intent: a tab is wide enough to show its own title (connection name)
 * in full. Only when the whole row cannot hold every title do the widest ones
 * get trimmed — water-filling keeps the cap uniform, so short names stay whole
 * while long ones shrink just enough to fit. When even the floors do not fit,
 * the caller switches the row to horizontal scrolling.
 */

export interface TabWidthRequest {
  /** Width each tab needs to render its title in full. */
  fullWidths: readonly number[];
  /** Width each tab may shrink to before the row starts scrolling. */
  minWidths: readonly number[];
  /** Room the row has, excluding the container's own padding. */
  available: number;
  /** Gap between two adjacent tabs. */
  gap: number;
}

export interface TabWidthPlan {
  /** Final width per tab, in the same order as the input. */
  widths: number[];
  /** True when even the minimum widths overflow — the row must scroll. */
  overflow: boolean;
}

export function planTabWidths(request: TabWidthRequest): TabWidthPlan {
  const count = Math.min(request.fullWidths.length, request.minWidths.length);
  if (count === 0) return { widths: [], overflow: false };

  const full = request.fullWidths.slice(0, count);
  const min = request.minWidths.slice(0, count);
  const gapTotal = request.gap * (count - 1);

  const widthAt = (index: number, cap: number): number =>
    Math.max(min[index], Math.min(full[index], cap));
  const widthSumAt = (cap: number): number =>
    full.reduce((sum, _width, index) => sum + widthAt(index, cap), 0);

  // Floor case: every tab at its minimum still overflows the row.
  if (widthSumAt(0) + gapTotal > request.available) return { widths: min.slice(), overflow: true };

  // Largest whole-pixel cap that still fits. Tabs at or below it keep their
  // natural width; everything longer is trimmed to the cap. Integer bisection
  // keeps the result exact, so a trimmed row never overshoots by a fraction.
  const budget = request.available - gapTotal;
  let lo = 0;
  let hi = Math.ceil(Math.max(...full));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (widthSumAt(mid) <= budget) lo = mid;
    else hi = mid - 1;
  }

  return { widths: full.map((_width, index) => widthAt(index, lo)), overflow: false };
}
