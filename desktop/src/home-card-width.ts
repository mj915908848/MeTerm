/**
 * home-card-width.ts — width model for the home page's saved-connection cards.
 *
 * A card is a flat 260px (`flex: 0 0 260px`) on a wrapping row, so a group whose
 * name or `user@host` is longer than that gets an ellipsis. A drag on the card's
 * right edge pins an explicit width for that one card; dropping the pin returns
 * it to 260px.
 *
 * The pin is kept per card — a named group or a `__type:ssh` bucket — because
 * whether a card needs to be wide depends on the names inside it, not on a
 * single global preference.
 *
 * Zero-dependency on purpose: the clamping and the storage format are the parts
 * worth testing, and the tests run in plain node.
 */

/** Narrower than this and the header ("N 个节点" + name) starts colliding. */
export const CARD_WIDTH_MIN = 220;
/**
 * The width a card renders at while it has no pin — mirrors the stylesheet's
 * `flex: 0 0 260px` (a guard test keeps the two in step).
 */
export const CARD_WIDTH_DEFAULT = 260;
/**
 * Upper bound for a *stored* pin. Deliberately larger than any sensible card so
 * that starting a drag on a card that is currently stretched across a wide
 * window (say 1400px) does not make it snap smaller on the first pixel of
 * movement. The CSS `max-width: 100%` still keeps it inside the row.
 */
export const CARD_WIDTH_MAX = 1600;

/** Storage key — one JSON object holding every pinned width. */
const CARD_WIDTHS_KEY = 'meterm-card-widths';

/**
 * Bring a width back into the range a card can actually be rendered at.
 * A non-finite input (NaN from a stray `parseFloat`, Infinity from a runaway
 * drag) falls back to the default rather than propagating.
 */
export function clampCardWidth(px: number): number {
  if (!Number.isFinite(px)) return CARD_WIDTH_DEFAULT;
  const rounded = Math.round(px);
  if (rounded < CARD_WIDTH_MIN) return CARD_WIDTH_MIN;
  if (rounded > CARD_WIDTH_MAX) return CARD_WIDTH_MAX;
  return rounded;
}

/**
 * Width a card should have after its right edge is dragged `deltaX` px from a
 * starting width of `startWidth`. Positive moves right (wider).
 */
export function dragCardWidth(startWidth: number, deltaX: number): number {
  const base = Number.isFinite(startWidth) ? startWidth : CARD_WIDTH_DEFAULT;
  const delta = Number.isFinite(deltaX) ? deltaX : 0;
  return clampCardWidth(base + delta);
}

/**
 * Read the stored map. Anything unexpected — absent key, malformed JSON, a
 * non-object, non-numeric entries — is dropped instead of thrown: this runs on
 * every home render, and one bad value must not take the page down.
 */
export function parseCardWidths(raw: string | null | undefined): Record<string, number> {
  const widths: Record<string, number> = {};
  if (!raw) return widths;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return widths;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return widths;

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key || typeof value !== 'number') continue;
    widths[key] = clampCardWidth(value);
  }
  return widths;
}

/**
 * Serialise the map with sorted keys and clamped values. Sorting keeps the
 * written string stable, so identical state produces identical bytes and a
 * diff of the stored value stays readable.
 */
export function serializeCardWidths(widths: Record<string, number>): string {
  const ordered: Record<string, number> = {};
  for (const key of Object.keys(widths).sort()) {
    ordered[key] = clampCardWidth(widths[key]);
  }
  return JSON.stringify(ordered);
}

export function loadCardWidths(): Record<string, number> {
  try {
    return parseCardWidths(localStorage.getItem(CARD_WIDTHS_KEY));
  } catch {
    return {};
  }
}

function persist(widths: Record<string, number>): void {
  try {
    localStorage.setItem(CARD_WIDTHS_KEY, serializeCardWidths(widths));
  } catch {
    // Storage unavailable (private mode / quota) — the card keeps the width for
    // this session only, which is better than breaking the drag.
  }
}

/** Pin one card's width. */
export function setCardWidth(cardKey: string, width: number): void {
  if (!cardKey) return;
  const widths = loadCardWidths();
  widths[cardKey] = clampCardWidth(width);
  persist(widths);
}

/** Drop the pin so the card goes back to filling the row on its own. */
export function clearCardWidth(cardKey: string): void {
  if (!cardKey) return;
  const widths = loadCardWidths();
  if (!(cardKey in widths)) return;
  delete widths[cardKey];
  persist(widths);
}
