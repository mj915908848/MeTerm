/**
 * editor-context-menu.ts — draws the editor window's right-click menu.
 *
 * Rendering only; *what* the menu contains comes from editor-menu-model.ts.
 *
 * The chrome (`custom-context-menu`, `custom-context-menu-item`,
 * `custom-context-menu-divider`) is the same set the main window's menus use —
 * toolbar.css and home.css are imported by main.ts, which every window loads —
 * so this menu looks identical to the ones elsewhere in the app without adding a
 * second set of styles.
 */
import { t } from './i18n';
import type { EditorMenuCommand, EditorMenuEntry } from './editor-menu-model';

/** Closes the open menu, if any. Safe to call when nothing is open. */
let activeCleanup: (() => void) | null = null;

function closeEditorContextMenu(): void {
  activeCleanup?.();
}

/** Keep the menu inside the window, the way the main window's menus do. */
function clampToViewport(menu: HTMLElement): void {
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(6, window.innerWidth - rect.width - 6)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(6, window.innerHeight - rect.height - 6)}px`;
  }
}

export function showEditorContextMenu(
  event: MouseEvent,
  entries: EditorMenuEntry[],
  onCommand: (command: EditorMenuCommand) => void,
): void {
  // Always swallow the event: whatever we decide to show, the WebKit default
  // menu (Reload / Share / AutoFill) must never appear in this window.
  event.preventDefault();
  event.stopPropagation();
  closeEditorContextMenu();

  if (entries.length === 0) return;

  const menu = document.createElement('div');
  menu.id = 'editor-context-menu';
  menu.className = 'custom-context-menu editor-context-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const cleanup = (): void => {
    if (activeCleanup !== cleanup) return;
    activeCleanup = null;
    menu.remove();
    document.removeEventListener('click', cleanup, true);
    window.removeEventListener('blur', cleanup);
    document.removeEventListener('keydown', onKeyDown, true);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') cleanup();
  };

  for (const entry of entries) {
    if (entry.kind === 'divider') {
      menu.appendChild(document.createElement('div')).className = 'custom-context-menu-divider';
      continue;
    }

    const item = document.createElement('button');
    item.className = 'custom-context-menu-item editor-menu-item';
    item.type = 'button';
    item.disabled = entry.disabled;

    // Fixed-width first column so labels line up whether or not a toggle is on.
    const check = document.createElement('span');
    check.className = 'editor-menu-check';
    check.textContent = entry.checked ? '✓' : '';
    item.appendChild(check);

    const label = document.createElement('span');
    label.className = 'editor-menu-label';
    label.textContent = t(entry.labelKey);
    item.appendChild(label);

    if (entry.shortcut) {
      const hint = document.createElement('span');
      hint.className = 'editor-menu-shortcut';
      hint.textContent = entry.shortcut;
      item.appendChild(hint);
    }

    item.addEventListener('click', () => {
      cleanup();
      onCommand(entry.command);
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  clampToViewport(menu);

  activeCleanup = cleanup;
  document.addEventListener('click', cleanup, true);
  window.addEventListener('blur', cleanup);
  document.addEventListener('keydown', onKeyDown, true);
}
