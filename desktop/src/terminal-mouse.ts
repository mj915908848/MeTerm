/**
 * terminal-mouse.ts — Copy on select (Settings › Terminal › Behavior).
 *
 * xterm finishes a mouse selection on mouseup, so the selection is read then.
 * The pane under the mouse is focused on mousedown (split-pane.ts), which makes
 * it the active session by the time mouseup arrives.
 */

import { writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { settings } from './app-state';

let lastCopied = '';

export function initTerminalMouseBehavior(): void {
  document.addEventListener('mouseup', (event) => {
    if (event.button !== 0 || !settings?.copyOnSelect) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.terminal-container')) return;
    // Let xterm finish updating the selection first.
    setTimeout(() => {
      const sessionId = TabManager.getActiveSessionId();
      const text = sessionId ? TerminalRegistry.getSessionSelection(sessionId) : '';
      if (!text || text === lastCopied) return;
      lastCopied = text;
      void clipboardWriteText(text);
    }, 0);
  });
  // A new mouse-down starts a new selection; allow copying the same text again.
  document.addEventListener('mousedown', () => { lastCopied = ''; }, true);
}
