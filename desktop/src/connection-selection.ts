/**
 * connection-selection.ts — multi-select rules for the connection list.
 *
 * Pure: no DOM, no storage. The list renderer, the drag controller and the
 * window that owns the selection all consult these functions, so the rules can
 * be exercised without a WebView.
 *
 * The one property that must never change: a plain click still *opens* the
 * connection. Selection is what the modifier keys add on top — a file-manager
 * habit, not a new primary action.
 */

export interface ClickModifiers {
  /** ⌘ on macOS, Ctrl elsewhere — add the row to / remove it from the selection. */
  toggle: boolean;
  /** Shift — select everything between the anchor and the clicked row. */
  range: boolean;
}

export interface ClickOutcome {
  selection: string[];
  /** Row the next shift-click ranges from. */
  anchor: string | null;
  /** Whether the caller should also open the connection. */
  connect: boolean;
}

export interface SelectionState {
  selection: readonly string[];
  anchor: string | null;
}

/**
 * What a click on `clickedKey` does to the selection.
 *
 * `visibleKeys` is the row order as rendered (collapsed groups contribute
 * nothing, because a range that silently spans hidden rows moves connections the
 * user cannot see). A shift-click whose anchor is gone falls back to a plain
 * single selection rather than selecting nothing.
 */
export function resolveRowClick(
  visibleKeys: readonly string[],
  state: SelectionState,
  clickedKey: string,
  mods: ClickModifiers,
): ClickOutcome {
  if (mods.range && state.anchor !== null) {
    const from = visibleKeys.indexOf(state.anchor);
    const to = visibleKeys.indexOf(clickedKey);
    if (from >= 0 && to >= 0) {
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      return { selection: visibleKeys.slice(lo, hi + 1), anchor: state.anchor, connect: false };
    }
    return { selection: [clickedKey], anchor: clickedKey, connect: false };
  }

  if (mods.toggle) {
    const selection = state.selection.includes(clickedKey)
      ? state.selection.filter((key) => key !== clickedKey)
      : [...state.selection, clickedKey];
    return { selection, anchor: clickedKey, connect: false };
  }

  // Plain click: still "open this connection". The selection is dropped so a
  // later drag cannot carry rows the user is no longer looking at.
  return { selection: [], anchor: clickedKey, connect: true };
}

/**
 * Rows a drag starting on `rowKey` should carry.
 *
 * Dragging a row that is part of the selection moves the whole selection;
 * dragging any other row moves just that row, so a drag never silently moves
 * something the user did not grab.
 */
export function keysToDrag(rowKey: string, selection: readonly string[]): string[] {
  return selection.includes(rowKey) ? [...selection] : [rowKey];
}

/** Drop keys that no longer exist, so the "N selected" count cannot lie. */
export function pruneSelection(
  selection: readonly string[],
  liveKeys: readonly string[],
): string[] {
  const live = new Set(liveKeys);
  return selection.filter((key) => live.has(key));
}
