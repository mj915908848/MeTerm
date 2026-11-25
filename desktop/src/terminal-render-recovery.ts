import { WebglAddon } from '@xterm/addon-webgl';
import { isMacPlatform } from './app-state';
import type { ManagedTerminal } from './terminal-types';

/**
 * Rebuild xterm's renderer-only state without resizing the terminal or PTY.
 *
 * This is intentionally separate from forceFullRefresh(), whose temporary
 * cols-1 resize is required to make TUI applications handle SIGWINCH after
 * system wake. A normal macOS focus transition must not mutate
 * terminal dimensions or notify the PTY.
 */
export function recoverTerminalRenderer(mt: ManagedTerminal): void {
  if (mt.ended) return;

  const core = (mt.terminal as any)._core;
  core?._renderService?.onIntersectionChange?.(true);
  core?.viewport?.onIntersectionChange?.(true);

  try {
    // xterm.js documents this as the recovery path for texture corruption
    // after GPU/OS suspend. It also schedules a full renderer refresh.
    mt.terminal.clearTextureAtlas();
  } catch (error) {
    console.warn(`[terminal ${mt.id}] failed to clear texture atlas`, error);
  }

  try {
    mt.terminal.refresh(0, Math.max(0, mt.terminal.rows - 1));
  } catch (error) {
    console.warn(`[terminal ${mt.id}] failed to refresh renderer`, error);
  }
}

export function scheduleTerminalRendererRecovery(terminals: Iterable<ManagedTerminal>): void {
  const targets = Array.from(terminals).filter((mt) =>
    !mt.ended && mt.container.classList.contains('active'));

  // Let WKWebView commit the foreground Metal layer before rebuilding the
  // atlas. A second frame avoids redrawing into the stale backing surface.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const mt of targets) {
        if (!mt.ended && mt.container.classList.contains('active')) {
          recoverTerminalRenderer(mt);
        }
      }
    });
  });
}

/**
 * The xterm 0.18 addon removes its canvas on dispose but leaves the WebGL
 * context alive until GC. Keep the private access here so a future addon can
 * replace it with a public API or release the context itself.
 */
function disposeWebgl(addon: WebglAddon): void {
  const context = (addon as WebglAddon & {
    _renderer?: { _gl?: WebGL2RenderingContext };
  })._renderer?._gl;
  try {
    addon.dispose();
  } finally {
    // Dispose first so deliberate context loss cannot trigger xterm recovery.
    context?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

export function releaseTerminalWebgl(mt: ManagedTerminal): void {
  const addon = mt.webglAddon;
  if (!addon) return;
  mt.webglAddon = null;
  try {
    disposeWebgl(addon);
  } catch (error) {
    console.warn(`[terminal ${mt.id}] failed to release WebGL renderer`, error);
  }
}

export function loadTerminalWebgl(mt: ManagedTerminal): void {
  if (mt.webglAddon || mt.canvasAddon || mt.terminal.options.allowTransparency
    || !mt.terminal.element || !mt.container.isConnected
    || !mt.container.classList.contains('active')) return;

  let addon: WebglAddon | undefined;
  try {
    addon = new WebglAddon();
    mt.terminal.loadAddon(addon);
    mt.webglAddon = addon;
  } catch {
    // Keep xterm's default renderer when WebGL is unavailable.
    if (addon) {
      mt.webglAddon = addon;
      releaseTerminalWebgl(mt);
    }
    return;
  }

  if (isMacPlatform) {
    addon.onContextLoss(() => {
      if (mt.ended || mt.webglAddon !== addon) return;
      console.warn(`[terminal ${mt.id}] WebGL context lost; falling back to the default renderer`);
      releaseTerminalWebgl(mt);
      requestAnimationFrame(() => recoverTerminalRenderer(mt));
    });
  }
}
