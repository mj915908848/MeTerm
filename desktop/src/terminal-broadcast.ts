/**
 * terminal-broadcast.ts — Send keyboard input to every pane of a tab.
 *
 * Toggled per tab (Cmd/Ctrl+Shift+I or the terminal context menu). While on,
 * whatever the user types or pastes into one pane is also sent to the other
 * panes of the same tab. Agent commands and other programmatic input are not
 * broadcast: they never pass through the terminal's onData.
 */

import { TabManager, type Tab } from './tabs';
import { TerminalRegistry } from './terminal';
import { getAllLeaves, countLeaves } from './split-pane';
import { isHomeView, isGalleryView } from './app-state';
import { t } from './i18n';

export function isBroadcasting(tab: Tab | null | undefined): boolean {
  return !!tab?.broadcastInput && countLeaves(tab.splitRoot) > 1;
}

function broadcastTargets(sessionId: string): string[] {
  const tab = TabManager.findTabBySessionId(sessionId);
  if (!isBroadcasting(tab)) return [];
  return getAllLeaves(tab!.splitRoot).map((l) => l.sessionId).filter((id) => id !== sessionId);
}

/** Show the broadcast frame on the panes of the visible tab. */
export function syncBroadcastIndicator(): void {
  const on = !isHomeView && !isGalleryView && isBroadcasting(TabManager.getActiveTab());
  document.querySelectorAll<HTMLElement>('.split-root').forEach((el) => {
    el.classList.toggle('broadcast-input', on);
    if (on) el.style.setProperty('--broadcast-label', JSON.stringify(t('broadcastInputBadge')));
  });
}

export function toggleInputBroadcast(tab: Tab | null = TabManager.getActiveTab()): void {
  if (!tab || countLeaves(tab.splitRoot) < 2) return;
  tab.broadcastInput = !tab.broadcastInput;
  TabManager.notify();
  syncBroadcastIndicator();
}

export function initInputBroadcast(): void {
  TerminalRegistry.setInputFanout(broadcastTargets);
  TabManager.subscribe(syncBroadcastIndicator);
}
