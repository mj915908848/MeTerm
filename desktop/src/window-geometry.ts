/**
 * window-geometry.ts — Remember and restore the main window's size and position.
 *
 * The geometry is stored in the shared settings object (`windowWidth`,
 * `windowHeight`, `windowX`, `windowY`, `windowMaximized`) so it travels with the
 * "remember window size" preference and survives a restart. The pure math lives
 * in window-geometry-core.ts.
 *
 * Two invariants keep it correct:
 *
 *  1. **Exactly one owner.** The primary window reads *and* writes the slot;
 *     extra `window-*` windows only inherit the remembered size (they are created
 *     at a meaningful position); utility windows stay out entirely. See
 *     `windowGeometryRole`.
 *  2. **Persisting is driven by the window's own move/resize events and flushed
 *     before the window closes.** It deliberately does NOT run inside the DOM
 *     `resize` handler: that handler does terminal fitting / home & gallery
 *     refresh first, so a throw anywhere above the save silently dropped the
 *     remembered geometry — and a window that was only *moved* was never
 *     remembered at all.
 */

import { availableMonitors, getCurrentWindow, type Window as TauriWindow } from '@tauri-apps/api/window';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { isPipMode, isWindowsPlatform } from './app-state';
import { loadSettings, updateSettings, type AppSettings } from './themes';
import {
  fitGeometryToScreen,
  fitGeometryToScreens,
  mergeGeometry,
  readStoredGeometry,
  windowGeometryRole,
  type ObservedWindowGeometry,
  type ScreenBounds,
  type WindowGeometry,
} from './window-geometry-core';

/** Coalesces the burst of move/resize events produced by a drag. */
const SAVE_DEBOUNCE_MS = 400;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
// 新保存请求使旧的 IPC 读取失效，防止迟到结果覆盖最新窗口状态。
// A newer save invalidates earlier IPC reads so late results cannot overwrite it.
let saveGeneration = 0;

/**
 * Logical size is what `setSize(new LogicalSize())` consumes, so physical values
 * read back from the window are converted with the same factor the rest of the
 * app already uses (see pip.ts / jumpserver-panel.ts).
 */
function deviceFactor(): number {
  return window.devicePixelRatio || 1;
}

/** Visible area of the display the window currently sits on. */
function currentScreenBounds(): ScreenBounds {
  const screen = window.screen as Screen & { availLeft?: number; availTop?: number };
  const width = Number.isFinite(screen?.availWidth) && screen.availWidth > 0
    ? screen.availWidth
    : window.innerWidth;
  const height = Number.isFinite(screen?.availHeight) && screen.availHeight > 0
    ? screen.availHeight
    : window.innerHeight;
  const x = Number.isFinite(screen?.availLeft) ? (screen.availLeft as number) : 0;
  const y = Number.isFinite(screen?.availTop) ? (screen.availTop as number) : 0;
  return { x, y, width, height };
}

function storedGeometryOf(settings: AppSettings): WindowGeometry | null {
  return readStoredGeometry({
    width: settings.windowWidth,
    height: settings.windowHeight,
    x: settings.windowX ?? null,
    y: settings.windowY ?? null,
    maximized: settings.windowMaximized === true,
  });
}

async function observeGeometry(win: TauriWindow): Promise<ObservedWindowGeometry> {
  const factor = deviceFactor();
  const [size, position, maximized] = await Promise.all([
    win.innerSize(),
    win.outerPosition(),
    win.isMaximized().catch(() => false),
  ]);
  return {
    width: Math.round(size.width / factor),
    height: Math.round(size.height / factor),
    x: Math.round(position.x / factor),
    y: Math.round(position.y / factor),
    maximized,
  };
}

/**
 * Write the window's current frame into the persisted settings.
 *
 * Reads the latest persisted settings rather than reusing an in-memory copy, so
 * this can never roll back a concurrent settings change.
 */
export async function persistMainWindowGeometry(win: TauriWindow = getCurrentWindow()): Promise<void> {
  if (windowGeometryRole(win.label) !== 'owner') return;
  const generation = ++saveGeneration;
  // PiP geometry is transient by design; pip.ts restores the pre-PiP frame itself.
  if (isPipMode) return;
  // Native macOS fullscreen resizes the window to the whole display; that frame
  // must never become the "preferred" size. fullscreen-mac.ts mirrors the state
  // onto `fs-mac` (isFullscreen() itself is not in the window capability set).
  if (document.documentElement.classList.contains('fs-mac')) return;

  if (!loadSettings().rememberWindowSize) return;

  let observed: ObservedWindowGeometry;
  try {
    observed = await observeGeometry(win);
  } catch {
    return; // window went away mid-flight
  }

  // Geometry reads cross IPC; a newer save or preference change may supersede them.
  if (generation !== saveGeneration) return;
  const settings = loadSettings();
  if (!settings.rememberWindowSize || isPipMode
      || document.documentElement.classList.contains('fs-mac')) return;
  const next = mergeGeometry(storedGeometryOf(settings), observed);
  updateSettings({
    windowWidth: next.width,
    windowHeight: next.height,
    windowX: next.x,
    windowY: next.y,
    windowMaximized: next.maximized,
  });
}

/**
 * Start remembering this window's geometry. No-op unless the window owns the slot.
 */
export function trackMainWindowGeometry(win: TauriWindow = getCurrentWindow()): void {
  if (windowGeometryRole(win.label) !== 'owner') return;

  const schedule = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persistMainWindowGeometry(win);
    }, SAVE_DEBOUNCE_MS);
  };

  void win.onResized(schedule);
  void win.onMoved(schedule);
}

/**
 * Persist immediately, cancelling any pending debounce.
 *
 * Called before the window closes or the app quits so that resizing and quitting
 * within the debounce window still remembers the new frame. Callers must await
 * it — the write only lands after the window geometry is read back — otherwise
 * the process can exit first.
 */
export function flushMainWindowGeometry(win: TauriWindow = getCurrentWindow()): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return persistMainWindowGeometry(win);
}

/**
 * Apply the remembered geometry to a freshly created window.
 *
 * The owner gets size + position (+ maximized); extra `window-*` windows only
 * inherit the size, because their position is chosen deliberately at creation
 * time. Failure is non-fatal: the window keeps the size declared in
 * tauri.conf.json.
 */
export async function restoreMainWindowGeometry(win: TauriWindow = getCurrentWindow()): Promise<void> {
  const role = windowGeometryRole(win.label);
  if (role === 'none') return;
  // Windows-only guard, kept from the previous implementation: resizing a
  // just-created secondary window during early init can stall WebView2 and leave
  // a blank, non-interactive window.
  if (role === 'inherit-size' && isWindowsPlatform) return;

  const settings = loadSettings();
  if (!settings.rememberWindowSize) return;

  const stored = storedGeometryOf(settings);
  if (!stored) return;

  const fallback = currentScreenBounds();
  let target = fitGeometryToScreen(stored, fallback);
  if (role === 'owner') {
    try {
      const monitors = await availableMonitors();
      const screens = monitors.map(monitor => {
        const factor = monitor.scaleFactor || 1;
        return {
          x: monitor.workArea.position.x / factor,
          y: monitor.workArea.position.y / factor,
          width: monitor.workArea.size.width / factor,
          height: monitor.workArea.size.height / factor,
        };
      });
      target = fitGeometryToScreens(stored, screens, fallback);
    } catch {
      // Fall back to the WebView screen if monitor enumeration is unavailable.
    }
  }
  const restorePosition = role === 'owner';

  try {
    await win.setSize(new LogicalSize(target.width, target.height));
    if (restorePosition && target.x !== null && target.y !== null) {
      await win.setPosition(new LogicalPosition(target.x, target.y));
    }
    if (restorePosition && target.maximized) {
      await win.maximize();
    }
  } catch (error) {
    console.warn('[window-geometry] failed to restore window geometry:', error);
  }
}
