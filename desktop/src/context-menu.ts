/**
 * context-menu.ts — Context menus (tab, shell, terminal, form field)
 *
 * Extracted from main.ts. Contains:
 * - showTabContextMenu()
 * - showShellContextMenu()
 * - showCustomContextMenu()
 * - showEditableContextMenu()
 * - getAvailableShells() / cachedShells
 */

import { TabManager, type Tab } from './tabs';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { AICapsuleManager } from './ai-capsule';
import { getAllLeaves, countLeaves, findLeafById } from './split-pane';
import { StatusBar } from './status-bar';
import { t } from './i18n';
import { buildFieldMenu, isFieldInputType } from './editable-menu-model';
import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import {
  readText as clipboardReadText,
  writeText as clipboardWriteText,
} from '@tauri-apps/plugin-clipboard-manager';
import { getSelection, performCopy, performPaste } from './clipboard-actions';
import { activateTab, showHomeView, openSettings, syncLockIconForActiveTab } from './view-manager';
import { doSplitPane, createNewSession, closeAllSessions } from './session-actions';
import { renderTabs } from './tab-renderer';
import {
  pendingMasterRequests,
  viewerModeSessionIds, privateSessionIds,
  reclaimSessionIds,
  removeKickedOverlay, removeReconnectOverlay,
} from './overlays';
import {
  settings,
  sshConfigMap, remoteInfoMap, sessionProgressMap,
  remoteTabNumbers, jumpServerConfigMap,
} from './app-state';
import type { SSHConnectionConfig } from './ssh';

// ── Shell info cache ──

interface ShellInfo {
  path: string;
  name: string;
  is_default: boolean;
}

let cachedShells: ShellInfo[] | null = null;

async function getAvailableShells(): Promise<ShellInfo[]> {
  if (cachedShells) return cachedShells;
  try {
    cachedShells = await invoke<ShellInfo[]>('list_available_shells');
  } catch {
    cachedShells = [];
  }
  return cachedShells;
}

/** Pre-cache shell list in background so context menu opens instantly. */
export function preloadShells(): void {
  void getAvailableShells();
}

/** Return the resolved default shell path from cached data (sync, best-effort). */
export function getDefaultShellPath(): string | undefined {
  if (!cachedShells) return undefined;
  const userDefault = settings.defaultShell;
  if (userDefault) return userDefault;
  return cachedShells.find((s) => s.is_default)?.path;
}

// ── Tab context menu ──

export function showTabContextMenu(event: MouseEvent, tab: Tab, tabIndex: number): void {
  event.preventDefault();
  event.stopPropagation();

  const existing = document.getElementById('custom-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'custom-context-menu';
  menu.className = 'custom-context-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const totalTabs = TabManager.tabs.length;

  const addItem = (label: string, onClick: () => void, disabled = false) => {
    const item = document.createElement('button');
    item.className = 'custom-context-menu-item';
    item.type = 'button';
    item.textContent = label;
    item.disabled = disabled;
    item.onclick = () => {
      menu.remove();
      onClick();
    };
    menu.appendChild(item);
  };

  const addDivider = () => {
    menu.appendChild(document.createElement('div')).className = 'custom-context-menu-divider';
  };

  const closeTab = async (tabId: string) => {
    const closingTab = TabManager.tabs.find((t) => t.id === tabId);
    if (closingTab) {
      const closingLeaves = getAllLeaves(closingTab.splitRoot);
      for (const leaf of closingLeaves) {
        DrawerManager.destroy(leaf.sessionId);
        AICapsuleManager.destroy(leaf.sessionId);
        sshConfigMap.delete(leaf.sessionId);
        jumpServerConfigMap.delete(leaf.sessionId);
        remoteInfoMap.delete(leaf.sessionId);
        remoteTabNumbers.delete(leaf.sessionId);
        viewerModeSessionIds.delete(leaf.sessionId);
        reclaimSessionIds.delete(leaf.sessionId);
        privateSessionIds.delete(leaf.sessionId);
        sessionProgressMap.delete(leaf.sessionId);
        removeKickedOverlay(leaf.sessionId);
        removeReconnectOverlay(leaf.sessionId);
      }
    }
    await TabManager.closeTab(tabId);
  };

  addItem(t('tabMenuCloseTab'), () => {
    void closeTab(tab.id).then(async () => {
      if (TabManager.activeTabId) {
        await activateTab(TabManager.activeTabId);
        const newActiveTab = TabManager.tabs.find(t => t.id === TabManager.activeTabId);
        if (newActiveTab) {
          const activeSessionId = TabManager.getActiveSessionId();
          const sshCfg = activeSessionId ? sshConfigMap.get(activeSessionId) : undefined;
          StatusBar.setConnection(newActiveTab.status, sshCfg ? `${sshCfg.username}@${sshCfg.host}` : 'Local');
        }
      } else {
        showHomeView();
      }
      renderTabs();
    });
  });

  addItem(t('tabMenuCloseOthers'), () => {
    const others = TabManager.tabs.filter((t) => t.id !== tab.id).map((t) => t.id);
    void (async () => {
      for (const id of others) await closeTab(id);
      TabManager.activate(tab.id);
      await activateTab(tab.id);
      renderTabs();
    })();
  }, totalTabs <= 1);

  addItem(t('tabMenuCloseLeft'), () => {
    const leftIds = TabManager.tabs.slice(0, tabIndex).map((t) => t.id);
    void (async () => {
      for (const id of leftIds) await closeTab(id);
      TabManager.activate(tab.id);
      await activateTab(tab.id);
      renderTabs();
    })();
  }, tabIndex === 0);

  addItem(t('tabMenuCloseRight'), () => {
    const rightIds = TabManager.tabs.slice(tabIndex + 1).map((t) => t.id);
    void (async () => {
      for (const id of rightIds) await closeTab(id);
      TabManager.activate(tab.id);
      await activateTab(tab.id);
      renderTabs();
    })();
  }, tabIndex === totalTabs - 1);

  addDivider();

  addItem(t('tabMenuCloseAll'), () => {
    void closeAllSessions();
  });

  addDivider();

  addItem(t('tabMenuCopyTitle'), () => {
    void clipboardWriteText(tab.title);
  });

  addItem(t('tabMenuCloneTab'), () => {
    // Check if any session in the tab is SSH
    const cloneLeaves = getAllLeaves(tab.splitRoot);
    let sshConfig: SSHConnectionConfig | undefined;
    for (const leaf of cloneLeaves) {
      const cfg = sshConfigMap.get(leaf.sessionId);
      if (cfg) { sshConfig = cfg; break; }
    }
    if (sshConfig) {
      document.dispatchEvent(new CustomEvent('ssh-clone-session', { detail: sshConfig }));
    } else {
      void createNewSession();
    }
  });

  // Lock/Unlock session (for local and SSH sessions, not remote viewer)
  const tabLeaves = getAllLeaves(tab.splitRoot);
  const isOwnedTab = tabLeaves.every((l) => !viewerModeSessionIds.has(l.sessionId) && !remoteInfoMap.has(l.sessionId));
  if (isOwnedTab) {
    const activeLeaf = tabLeaves[0];
    if (activeLeaf) {
      const isPrivate = privateSessionIds.has(activeLeaf.sessionId);
      addItem(isPrivate ? t('tabMenuUnlockSession') : t('tabMenuLockSession'), () => {
        const newPrivate = !isPrivate;
        void (async () => {
          if (newPrivate) {
            const confirmed = await confirm(t('lockSessionConfirm'), {
              title: t('tabMenuLockSession'),
              kind: 'warning',
              okLabel: t('tabMenuLockSession'),
              cancelLabel: t('hideToTrayTipCancel'),
            });
            if (!confirmed) return;
          }
          try {
            await invoke('set_session_private', { sessionId: activeLeaf.sessionId, private: newPrivate });
            if (newPrivate) {
              privateSessionIds.add(activeLeaf.sessionId);
            } else {
              privateSessionIds.delete(activeLeaf.sessionId);
            }
            syncLockIconForActiveTab();
            renderTabs();
          } catch (err) {
            console.error('set_session_private failed:', err);
          }
        })();
      });
    }
  }

  addDivider();

  const splitDisabled = false; // split limit removed
  addItem(t('splitHorizontal'), () => {
    void (async () => {
      TabManager.activate(tab.id);
      await doSplitPane(tab.id, tab.focusedPaneId, 'horizontal');
      await activateTab(tab.id);
      renderTabs();
    })();
  }, splitDisabled);

  addItem(t('splitVertical'), () => {
    void (async () => {
      TabManager.activate(tab.id);
      await doSplitPane(tab.id, tab.focusedPaneId, 'vertical');
      await activateTab(tab.id);
      renderTabs();
    })();
  }, splitDisabled);

  document.body.appendChild(menu);

  // Boundary detection
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  if (rect.right > viewportWidth) {
    menu.style.left = `${Math.max(6, viewportWidth - rect.width - 6)}px`;
  }
  if (rect.bottom > viewportHeight) {
    menu.style.top = `${Math.max(6, viewportHeight - rect.height - 6)}px`;
  }

  const cleanup = () => {
    menu.remove();
    document.removeEventListener('click', cleanup, true);
    window.removeEventListener('blur', cleanup);
  };
  document.addEventListener('click', cleanup, true);
  window.addEventListener('blur', cleanup);
}

// ── Shell selection context menu ──

export function showShellContextMenu(event: MouseEvent, anchor?: HTMLElement): void {
  event.preventDefault();
  event.stopPropagation();

  const existing = document.getElementById('shell-context-menu');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'shell-context-menu';
  menu.className = 'custom-context-menu';

  // Position near anchor or mouse
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
  } else {
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
  }

  const cleanup = () => {
    menu.remove();
    document.removeEventListener('click', onClickOutside, true);
    window.removeEventListener('blur', cleanup);
  };
  const onClickOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) cleanup();
  };

  // Loading placeholder
  const loading = document.createElement('div');
  loading.className = 'custom-context-menu-item';
  loading.textContent = '...';
  loading.style.opacity = '0.5';
  menu.appendChild(loading);

  document.body.appendChild(menu);

  // Ensure menu doesn't go off-screen
  requestAnimationFrame(() => {
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth) menu.style.left = `${window.innerWidth - mr.width - 8}px`;
    if (mr.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - mr.height - 8}px`;
  });

  setTimeout(() => {
    document.addEventListener('click', onClickOutside, true);
    window.addEventListener('blur', cleanup);
  }, 0);

  // Load shells and populate
  void getAvailableShells().then((shells) => {
    menu.innerHTML = '';
    if (shells.length === 0) {
      const item = document.createElement('div');
      item.className = 'custom-context-menu-item';
      item.textContent = t('noShellsFound');
      item.style.opacity = '0.5';
      menu.appendChild(item);
      return;
    }

    // Determine effective default: user setting overrides system default
    const userDefault = settings.defaultShell;
    const isDefault = (s: ShellInfo) => userDefault ? s.path === userDefault : s.is_default;
    const defaultShells = shells.filter(isDefault);
    const otherShells = shells.filter((s) => !isDefault(s));

    const addShellItem = (shell: ShellInfo, showBadge: boolean) => {
      const item = document.createElement('button');
      item.className = 'custom-context-menu-item';
      item.type = 'button';
      item.textContent = shell.name;
      if (showBadge) {
        const badge = document.createElement('span');
        badge.className = 'shell-default-badge';
        badge.textContent = t('defaultShell');
        item.appendChild(badge);
      }
      item.onclick = () => {
        cleanup();
        void createNewSession(shell.path);
      };
      menu.appendChild(item);
    };

    for (const shell of defaultShells) addShellItem(shell, true);
    if (defaultShells.length > 0 && otherShells.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'custom-context-menu-divider';
      menu.appendChild(sep);
    }
    for (const shell of otherShells) addShellItem(shell, false);

    // Re-check position after content loaded
    requestAnimationFrame(() => {
      const mr = menu.getBoundingClientRect();
      if (mr.right > window.innerWidth) menu.style.left = `${window.innerWidth - mr.width - 8}px`;
      if (mr.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - mr.height - 8}px`;
    });
  });
}

// ── Form fields: the app's own editing menu ──

export type EditableField = HTMLInputElement | HTMLTextAreaElement;

/**
 * The text field that owns this right-click, or null when the element is not one.
 *
 * xterm keeps a hidden textarea for keyboard input. It must never be mistaken for
 * a form field: that would replace the terminal's own menu (copy / paste / split /
 * close session) with the four text commands. `performPaste` excludes it for the
 * same reason.
 *
 * `<select>` is deliberately not a field here — the platform's own menu is the
 * only useful one for a dropdown, and the app has nothing to add to it.
 */
export function editableFieldAt(target: EventTarget | null): EditableField | null {
  if (target instanceof HTMLTextAreaElement) {
    return target.classList.contains('xterm-helper-textarea') ? null : target;
  }
  if (target instanceof HTMLInputElement && isFieldInputType(target.type)) return target;
  return null;
}

/**
 * The field's selection, or the caret at the end when the type has none.
 *
 * Every type this menu serves carries a selection, so the fallback is a guard
 * rather than a path: it keeps a field that reports no selection (a mock, an
 * engine that changes its mind) from turning into a thrown exception or a `NaN`
 * edit. Types that genuinely have no selection — `number`, the date pickers — are
 * not served at all; see `isFieldInputType`.
 */
function fieldSelection(field: EditableField): { start: number; end: number } {
  try {
    const start = field.selectionStart;
    const end = field.selectionEnd;
    if (typeof start === 'number' && typeof end === 'number') return { start, end };
  } catch {
    // Thrown by types that do not implement the selection API.
  }
  const end = field.value.length;
  return { start: end, end };
}

/**
 * Replace `range` with `text` and leave the caret after it.
 *
 * Mirrors what `performPaste` does for a field, but takes the range explicitly:
 * the menu button steals focus when it is pressed, so re-reading the selection at
 * that point would find nothing.
 */
function replaceFieldSelection(
  field: EditableField,
  range: { start: number; end: number },
  text: string,
): void {
  if (field.readOnly || field.disabled) return;
  // Focus first: setting a selection on a blurred field leaves no visible caret,
  // so the edit would look like it happened somewhere else.
  field.focus();
  field.value = field.value.slice(0, range.start) + text + field.value.slice(range.end);
  const caret = range.start + text.length;
  try {
    field.setSelectionRange(caret, caret);
  } catch {
    // Same unsupported types as above — the value still changed.
  }
  // Dialogs listen for `input` (the SSH/JumpServer port boxes sanitise their
  // digits there, and the dirty check reads the field), so a programmatic
  // `.value` write has to announce itself.
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Draw the app's own menu for a text field, replacing WKWebView's.
 *
 * Every entry is a plain field edit against the selection captured when the menu
 * opened: no WebKit menu means cut/copy/paste/select-all have to actually work
 * here, or the fix would cost the user functionality rather than restore it.
 */
export function showEditableContextMenu(event: MouseEvent, field: EditableField): void {
  event.preventDefault();
  event.stopPropagation();

  const existing = document.getElementById('custom-context-menu');
  if (existing) existing.remove();

  // Snapshot while the field still owns the selection: pressing a menu button
  // moves focus away from it.
  const range = fieldSelection(field);

  const menu = document.createElement('div');
  menu.id = 'custom-context-menu';
  menu.className = 'custom-context-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const items = buildFieldMenu({
    hasSelection: range.end > range.start,
    hasText: field.value.length > 0,
    editable: !field.readOnly && !field.disabled,
  });

  const cleanup = () => {
    menu.remove();
    document.removeEventListener('click', cleanup, true);
    window.removeEventListener('blur', cleanup);
  };

  for (const entry of items) {
    const item = document.createElement('button');
    item.className = 'custom-context-menu-item';
    item.type = 'button';
    item.textContent = t(entry.labelKey);
    item.disabled = entry.disabled;
    item.onclick = () => {
      cleanup();
      // A rejected clipboard call would otherwise surface as an unhandled
      // rejection — the window may simply not be granted the clipboard plugin.
      const failed = (error: unknown) => console.error('[context-menu] clipboard failed:', error);
      switch (entry.command) {
        case 'cut':
          void clipboardWriteText(field.value.slice(range.start, range.end))
            .then(() => replaceFieldSelection(field, range, ''))
            .catch(failed);
          break;
        case 'copy':
          void clipboardWriteText(field.value.slice(range.start, range.end)).catch(failed);
          break;
        case 'paste':
          void clipboardReadText()
            .then((text) => { if (text) replaceFieldSelection(field, range, text); })
            .catch(failed);
          break;
        case 'selectAll':
          field.focus();
          try {
            field.select();
          } catch {
            // Only reachable for a type with no selection at all, which this menu
            // does not serve (see `isFieldInputType`). Rewriting the value would
            // not select anything, so leave the field as it is.
          }
          break;
      }
    };
    menu.appendChild(item);
  }

  document.body.appendChild(menu);

  // Boundary detection
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  if (rect.right > viewportWidth) {
    menu.style.left = `${Math.max(6, viewportWidth - rect.width - 6)}px`;
  }
  if (rect.bottom > viewportHeight) {
    menu.style.top = `${Math.max(6, viewportHeight - rect.height - 6)}px`;
  }

  document.addEventListener('click', cleanup, true);
  window.addEventListener('blur', cleanup);
}

// ── Terminal context menu ──

export function showCustomContextMenu(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  // Text fields get the app's own cut/copy/paste/select-all menu. Letting them
  // keep WKWebView's puts a browser menu — Look Up, Translate, Inspect Element —
  // inside an app dialog, which is the complaint the connection window's menu
  // already answered.
  const field = editableFieldAt(target);
  if (field) {
    showEditableContextMenu(event, field);
    return;
  }
  // A dropdown keeps the native menu: there is nothing the app could add to it.
  if (target instanceof HTMLSelectElement) {
    return;
  }
  // Let AI chat panel handle its own context menu (suppress system menu but don't show terminal menu)
  if (target?.closest('.ai-chat-messages')) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  // Only show terminal context menu when right-clicking inside the terminal area
  // (.xterm or .terminal-container), not on AI bar, drawers, home, toolbars, etc.
  const inTerminal = target?.closest('.xterm') || target?.closest('.terminal-container');
  if (!inTerminal) {
    return;
  }
  const existing = document.getElementById('custom-context-menu');
  if (existing) {
    existing.remove();
  }

  const menu = document.createElement('div');
  menu.id = 'custom-context-menu';
  menu.className = 'custom-context-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const addItem = (label: string, onClick: () => void, disabled = false) => {
    const item = document.createElement('button');
    item.className = 'custom-context-menu-item';
    item.type = 'button';
    item.textContent = label;
    item.disabled = disabled;
    item.onclick = () => {
      menu.remove();
      onClick();
    };
    menu.appendChild(item);
  };

  addItem(t('contextMenuNewTerminal'), () => {
    void createNewSession();
  });
  addItem(t('contextMenuHome'), () => {
    showHomeView();
    renderTabs();
  });
  addItem(t('contextMenuSettings'), () => {
    openSettings();
  });
  addItem(t('contextMenuCloseSession'), () => {
    if (TabManager.activeTabId) {
      const activeTab = TabManager.getActiveTab();
      if (activeTab) {
        const closingLeaves = getAllLeaves(activeTab.splitRoot);
        for (const leaf of closingLeaves) {
          DrawerManager.destroy(leaf.sessionId);
          AICapsuleManager.destroy(leaf.sessionId);
          sshConfigMap.delete(leaf.sessionId);
          jumpServerConfigMap.delete(leaf.sessionId);
          remoteInfoMap.delete(leaf.sessionId);
          remoteTabNumbers.delete(leaf.sessionId);
          viewerModeSessionIds.delete(leaf.sessionId);
          reclaimSessionIds.delete(leaf.sessionId);
          sessionProgressMap.delete(leaf.sessionId);
          removeKickedOverlay(leaf.sessionId);
          removeReconnectOverlay(leaf.sessionId);
        }
      }
      void TabManager.closeTab(TabManager.activeTabId).then(async () => {
        if (TabManager.activeTabId) {
          await activateTab(TabManager.activeTabId);
          const newActiveTab = TabManager.tabs.find(t => t.id === TabManager.activeTabId);
          if (newActiveTab) {
            const activeSessionId = TabManager.getActiveSessionId();
            const sshCfg = activeSessionId ? sshConfigMap.get(activeSessionId) : undefined;
            StatusBar.setConnection(newActiveTab.status, sshCfg ? `${sshCfg.username}@${sshCfg.host}` : 'Local');
          }
        } else {
          showHomeView();
        }
        renderTabs();
      });
    }
  }, !TabManager.activeTabId);

  menu.appendChild(document.createElement('div')).className = 'custom-context-menu-divider';

  const hasSelection = !!getSelection();
  addItem(t('contextMenuCopy'), () => {
    performCopy();
  }, !hasSelection);
  addItem(t('contextMenuPaste'), () => {
    performPaste();
  });

  // Split pane items
  const activeTabForCtx = TabManager.getActiveTab();
  if (activeTabForCtx) {
    menu.appendChild(document.createElement('div')).className = 'custom-context-menu-divider';
    const splitCtxDisabled = false; // split limit removed
    addItem(t('splitHorizontal'), () => {
      void (async () => {
        await doSplitPane(activeTabForCtx.id, activeTabForCtx.focusedPaneId, 'horizontal');
        await activateTab(activeTabForCtx.id);
        renderTabs();
      })();
    }, splitCtxDisabled);
    addItem(t('splitVertical'), () => {
      void (async () => {
        await doSplitPane(activeTabForCtx.id, activeTabForCtx.focusedPaneId, 'vertical');
        await activateTab(activeTabForCtx.id);
        renderTabs();
      })();
    }, splitCtxDisabled);

    if (countLeaves(activeTabForCtx.splitRoot) > 1) {
      addItem(settings?.language === 'zh' ? '抽取为独立标签' : 'Extract pane to new tab', () => {
        const newTabId = TabManager.extractPaneToNewTab(activeTabForCtx.id, activeTabForCtx.focusedPaneId);
        if (newTabId) {
          void (async () => {
            // Re-render the source tab (pane removed) then activate the new tab.
            await activateTab(newTabId);
            renderTabs();
          })();
        }
      });
      addItem(t('closePane'), () => {
        const closingLeaf = findLeafById(activeTabForCtx.splitRoot, activeTabForCtx.focusedPaneId);
        if (closingLeaf) {
          DrawerManager.destroy(closingLeaf.sessionId);
          AICapsuleManager.destroy(closingLeaf.sessionId);
          sshConfigMap.delete(closingLeaf.sessionId);
          jumpServerConfigMap.delete(closingLeaf.sessionId);
          remoteInfoMap.delete(closingLeaf.sessionId);
          remoteTabNumbers.delete(closingLeaf.sessionId);
          viewerModeSessionIds.delete(closingLeaf.sessionId);
          reclaimSessionIds.delete(closingLeaf.sessionId);
          { const pr = pendingMasterRequests.get(closingLeaf.sessionId); if (pr) { clearTimeout(pr.timerId); pendingMasterRequests.delete(closingLeaf.sessionId); } }
          sessionProgressMap.delete(closingLeaf.sessionId);
          removeKickedOverlay(closingLeaf.sessionId);
          removeReconnectOverlay(closingLeaf.sessionId);
        }
        void TabManager.closePane(activeTabForCtx.id, activeTabForCtx.focusedPaneId).then(async () => {
          if (TabManager.activeTabId) {
            await activateTab(TabManager.activeTabId);
          }
          renderTabs();
        });
      });
    }
  }

  document.body.appendChild(menu);

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  if (rect.right > viewportWidth) {
    menu.style.left = `${Math.max(6, viewportWidth - rect.width - 6)}px`;
  }
  if (rect.bottom > viewportHeight) {
    menu.style.top = `${Math.max(6, viewportHeight - rect.height - 6)}px`;
  }

  const cleanup = () => {
    menu.remove();
    document.removeEventListener('click', cleanup, true);
    window.removeEventListener('blur', cleanup);
  };
  document.addEventListener('click', cleanup, true);
  window.addEventListener('blur', cleanup);
}

// ── Utility windows: never the WebView's own menu ──

/**
 * Replace the WebView's built-in context menu in a utility window.
 *
 * The main window answers with the app's own menu (showCustomContextMenu); a
 * window that registers nothing — the connections window, for one — got
 * WKWebView's instead: "Reload" and "Inspect Element". That reads as a browser
 * page rather than an app, and "Reload" would discard the list the user is
 * working in.
 *
 * Text fields are routed to the app's editing menu rather than exempted: they
 * used to keep the native one, which is what still put a browser menu (Look Up /
 * Translate / Inspect Element) on the 添加 JumpServer dialog's server-address box.
 * A dropdown is the one exception that stays native — the app has nothing to add.
 */
export function suppressNativeContextMenu(): void {
  document.addEventListener('contextmenu', (event) => {
    const target = event.target as HTMLElement | null;
    const field = editableFieldAt(target);
    if (field) {
      showEditableContextMenu(event, field);
      return;
    }
    if (target instanceof HTMLSelectElement) {
      return;
    }
    event.preventDefault();
  });
}
