/**
 * window-geometry-core.ts — Pure geometry math behind the remembered main-window
 * size/position.
 *
 * Deliberately free of Tauri and DOM imports so it can be unit-tested under Node
 * (see tests/window-geometry.test.mts). The Tauri wiring lives in
 * window-geometry.ts.
 */

/**
 * How a window relates to the remembered geometry.
 *
 * There is a single persisted slot, so exactly one window may own it:
 *
 * - `owner`        — the primary window. Reads *and* writes size/position/maximized.
 * - `inherit-size` — extra windows (`window-*`). They inherit the remembered size
 *                    so a new window opens at a sensible size, but they are
 *                    created at a position that matters (centred on the cursor by
 *                    `createWindowAtPosition`), so they must not take the
 *                    remembered position — and must not write the slot, or the
 *                    last window you happened to touch would silently redefine
 *                    where and how big the next launch is.
 * - `none`         — utility windows (settings / editor / about / updater /
 *                    jumpserver-browser). They share the settings object but have
 *                    their own lifecycle and must stay out of this slot entirely.
 */
export type WindowGeometryRole = 'owner' | 'inherit-size' | 'none';

export function windowGeometryRole(label: string): WindowGeometryRole {
  if (label === 'main') return 'owner';
  if (label.startsWith('window-')) return 'inherit-size';
  return 'none';
}

/** A remembered size below this is treated as corrupt rather than restored. */
export const MIN_RESTORABLE_WIDTH = 320;
export const MIN_RESTORABLE_HEIGHT = 240;

/**
 * How much of the remembered frame must land inside the screen. Below this the
 * position is dropped and the OS is allowed to place the window itself — a
 * window remembered on a display that is no longer attached must not come back
 * off-screen.
 */
export const MIN_VISIBLE_EDGE = 80;

export interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Geometry as persisted inside AppSettings (unknown-typed: storage is untrusted). */
export interface StoredWindowGeometry {
  width: unknown;
  height: unknown;
  x: unknown;
  y: unknown;
  maximized: unknown;
}

export interface WindowGeometry {
  width: number;
  height: number;
  /** Logical top-left; null means "let the OS decide". */
  x: number | null;
  y: number | null;
  maximized: boolean;
}

/** Geometry read back from the live window. */
export interface ObservedWindowGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Parse the remembered geometry out of stored settings.
 *
 * Returns null when the size is missing or unusable, in which case the caller
 * keeps the window size declared in tauri.conf.json.
 */
export function readStoredGeometry(stored: StoredWindowGeometry): WindowGeometry | null {
  const width = finiteOrNull(stored.width);
  const height = finiteOrNull(stored.height);
  if (width === null || height === null) return null;
  if (width < MIN_RESTORABLE_WIDTH || height < MIN_RESTORABLE_HEIGHT) return null;

  return {
    width: Math.round(width),
    height: Math.round(height),
    x: finiteOrNull(stored.x),
    y: finiteOrNull(stored.y),
    maximized: stored.maximized === true,
  };
}

/**
 * Fit a remembered geometry onto the screens that are attached right now.
 *
 * The size is capped to the screen so a window remembered on a larger external
 * display still fits, and a position that would leave the window (nearly)
 * invisible is discarded in favour of default placement.
 */
export function fitGeometryToScreen(geometry: WindowGeometry, bounds: ScreenBounds): WindowGeometry {
  const maxWidth = Math.max(MIN_RESTORABLE_WIDTH, Math.round(bounds.width));
  const maxHeight = Math.max(MIN_RESTORABLE_HEIGHT, Math.round(bounds.height));
  const width = clamp(Math.round(geometry.width), MIN_RESTORABLE_WIDTH, maxWidth);
  const height = clamp(Math.round(geometry.height), MIN_RESTORABLE_HEIGHT, maxHeight);

  if (geometry.x === null || geometry.y === null) {
    return { width, height, x: null, y: null, maximized: geometry.maximized };
  }

  const x = Math.round(geometry.x);
  const y = Math.round(geometry.y);
  const visibleWidth = Math.min(x + width, bounds.x + bounds.width) - Math.max(x, bounds.x);
  const visibleHeight = Math.min(y + height, bounds.y + bounds.height) - Math.max(y, bounds.y);
  if (visibleWidth < MIN_VISIBLE_EDGE || visibleHeight < MIN_VISIBLE_EDGE) {
    return { width, height, x: null, y: null, maximized: geometry.maximized };
  }

  return { width, height, x, y, maximized: geometry.maximized };
}

/**
 * Merge a freshly observed window frame into the remembered geometry.
 *
 * While the window is maximized/fullscreen the observed frame is the maximized
 * one, which must never be stored as the "preferred" size — otherwise
 * un-maximizing (or the next launch) would produce a permanently full-screen
 * window. A maximized window therefore only records the flag and keeps the last
 * un-maximized frame.
 */
export function mergeGeometry(
  previous: WindowGeometry | null,
  observed: ObservedWindowGeometry,
): WindowGeometry {
  if (observed.maximized) {
    return {
      width: previous?.width ?? Math.max(MIN_RESTORABLE_WIDTH, Math.round(observed.width)),
      height: previous?.height ?? Math.max(MIN_RESTORABLE_HEIGHT, Math.round(observed.height)),
      x: previous?.x ?? Math.round(observed.x),
      y: previous?.y ?? Math.round(observed.y),
      maximized: true,
    };
  }

  return {
    width: Math.max(MIN_RESTORABLE_WIDTH, Math.round(observed.width)),
    height: Math.max(MIN_RESTORABLE_HEIGHT, Math.round(observed.height)),
    x: Math.round(observed.x),
    y: Math.round(observed.y),
    maximized: false,
  };
}

/** Choose the attached display with the largest overlap with the saved frame. */
export function fitGeometryToScreens(
  geometry: WindowGeometry,
  screens: readonly ScreenBounds[],
  fallback: ScreenBounds,
): WindowGeometry {
  let target = fallback;
  let bestArea = 0;
  if (geometry.x !== null && geometry.y !== null) {
    for (const screen of screens) {
      const width = Math.max(0, Math.min(geometry.x + geometry.width, screen.x + screen.width) - Math.max(geometry.x, screen.x));
      const height = Math.max(0, Math.min(geometry.y + geometry.height, screen.y + screen.height) - Math.max(geometry.y, screen.y));
      if (width * height > bestArea) {
        bestArea = width * height;
        target = screen;
      }
    }
  }
  return fitGeometryToScreen(geometry, target);
}
