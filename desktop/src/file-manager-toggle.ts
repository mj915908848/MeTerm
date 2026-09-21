/**
 * file-manager-toggle.ts — Shared toggle/switch logic for file manager modes
 */

import { DrawerManager } from './drawer';
import { SidebarManager } from './file-sidebar';
import { TerminalRegistry } from './terminal';
import { TabManager } from './tabs';
import { loadSettings, updateSettings } from './themes';

/**
 * Whether the file manager is currently open for a session, in whichever
 * mode (drawer/sidebar) is active. Used to drive the toolbar button's
 * active state.
 */
export function isFileManagerOpen(sessionId: string): boolean {
  const mode = loadSettings().fileManagerMode;
  return mode === 'sidebar'
    ? SidebarManager.isOpen(sessionId)
    : DrawerManager.isOpen(sessionId);
}

/**
 * Toggle file manager visibility for a session (show/hide).
 * Uses the current mode (drawer/sidebar) from settings.
 */
export function toggleFileManager(sessionId: string): void {
  const mode = loadSettings().fileManagerMode;
  // The left dock holds a single panel: opening the file sidebar gives way to
  // the server-info panel, and vice versa.
  const willOpen = mode === 'sidebar' ? !SidebarManager.isOpen(sessionId) : !DrawerManager.isOpen(sessionId);
  if (willOpen && mode === 'sidebar') {
    void import('./server-info-panel').then((m) => m.ServerInfoPanel.close());
  }
  if (mode === 'sidebar') {
    if (!SidebarManager.has(sessionId)) {
      SidebarManager.create(sessionId);
    }
    const mainContent = document.getElementById('main-content');
    if (mainContent) SidebarManager.mountTo(sessionId, mainContent);
    SidebarManager.toggle(sessionId);
  } else {
    // Ensure drawer is mounted before toggling
    const terminalPanel = document.getElementById('terminal-panel');
    if (terminalPanel) DrawerManager.mountTo(sessionId, terminalPanel);
    DrawerManager.toggle(sessionId);
  }
  // Re-render toolbar to update active state
  requestAnimationFrame(() => {
    import('./toolbar').then(({ renderToolbarActions }) => renderToolbarActions());
  });
}

/**
 * Switch file manager mode (drawer ↔ sidebar) for the active session.
 * Closes the old mode and opens the new one.
 */
export async function switchFileManagerMode(sessionId: string): Promise<void> {
  const s = loadSettings();
  const oldMode = s.fileManagerMode;
  const newMode = oldMode === 'sidebar' ? 'drawer' : 'sidebar';
  updateSettings({ fileManagerMode: newMode });

  // Hide old mode
  if (oldMode === 'sidebar') {
    if (SidebarManager.isOpen(sessionId)) {
      SidebarManager.toggle(sessionId); // close
    }
  } else {
    if (DrawerManager.isOpen(sessionId)) {
      DrawerManager.toggle(sessionId); // close
    }
  }

  // Open new mode
  if (newMode === 'sidebar') {
    // Sidebar mode needs the left dock — hand it over from the server-info panel.
    const { ServerInfoPanel } = await import('./server-info-panel');
    ServerInfoPanel.close();
    if (!SidebarManager.has(sessionId)) {
      SidebarManager.create(sessionId);
      const mainContent = document.getElementById('main-content');
      if (mainContent) SidebarManager.mountTo(sessionId, mainContent);
    }
    SidebarManager.toggle(sessionId); // open
  } else {
    const terminalPanel = document.getElementById('terminal-panel');
    if (terminalPanel) DrawerManager.mountTo(sessionId, terminalPanel);
    DrawerManager.toggle(sessionId); // open
  }

  requestAnimationFrame(() => TerminalRegistry.resizeAll());

  // Re-render toolbar to reflect new state
  const { renderToolbarActions } = await import('./toolbar');
  renderToolbarActions();
}

/**
 * Close the left-docked file sidebar (sidebar mode) if it is open, leaving the
 * dock free. Used by the server-info panel, which claims the same dock slot.
 * Drawer mode (bottom) is unaffected — the two can coexist.
 */
export function closeFileSidebarForDockSwap(): void {
  if (loadSettings().fileManagerMode !== 'sidebar') return;
  const sessionId = TabManager.getActiveSessionId();
  if (!sessionId || !SidebarManager.isOpen(sessionId)) return;
  SidebarManager.closeImmediate(sessionId);
  requestAnimationFrame(() => {
    import('./toolbar').then(({ renderToolbarActions }) => renderToolbarActions());
  });
}
