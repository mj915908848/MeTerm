/**
 * editor-menu-model.ts — what the editor window's right-click menu contains.
 *
 * The editor window installed no context menu of its own, so a right-click fell
 * through to WebKit's default one (Reload / Share / Inspect Element / AutoFill).
 * Those labels come from the system and stay English no matter what the app
 * language is, and worse, "Reload" discards the editor's entire view state —
 * which the main window's file bridge never learns about, so reopening the same
 * file afterwards only ever shows "Loading...".
 *
 * This module decides *which* items the menu has and whether they are enabled.
 * editor-context-menu.ts draws the result. The decision is kept pure so it can be
 * unit-tested without a DOM (the node test runner has none).
 */

export type EditorMenuCommand =
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'save'
  | 'closeTab'
  | 'closeOthers'
  | 'closeLeft'
  | 'closeRight'
  | 'closeAll'
  | 'wordWrap'
  | 'mdPreview'
  | 'format';

export interface EditorMenuItem {
  kind: 'item';
  command: EditorMenuCommand;
  /** i18n key, resolved at render time so the menu follows a language change. */
  labelKey: EditorMenuLabelKey;
  /** Accelerator hint, e.g. `⌘C`. Empty string when the action has no binding. */
  shortcut: string;
  disabled: boolean;
  /** Only set for toggles; the renderer draws a check mark for `true`. */
  checked?: boolean;
}

/**
 * The label keys, spelled out as a literal union rather than `string`. That keeps
 * this module free of the i18n import (so it stays loadable in the node test
 * runner) while still letting `t()` type-check the lookup at the render site —
 * a missing or renamed key becomes a compile error instead of a blank menu.
 */
export type EditorMenuLabelKey =
  | 'editorCut'
  | 'editorCopy'
  | 'editorPaste'
  | 'editorSelectAll'
  | 'editorSave'
  | 'editorCloseTab'
  | 'editorWordWrap'
  | 'editorMdPreview'
  | 'editorFormat'
  // Shared with the window tab strip's menu, so both read identically.
  | 'tabMenuCloseTab'
  | 'tabMenuCloseOthers'
  | 'tabMenuCloseLeft'
  | 'tabMenuCloseRight'
  | 'tabMenuCloseAll';

export interface EditorMenuDivider {
  kind: 'divider';
}

export type EditorMenuEntry = EditorMenuItem | EditorMenuDivider;

export interface EditorMenuContext {
  /** Image tabs are a read-only preview — no editor view, so no text commands. */
  isImage: boolean;
  hasSelection: boolean;
  isMarkdown: boolean;
  wrapLines: boolean;
  previewOpen: boolean;
  canFormat: boolean;
}

/** Single source of truth for the label of each command. */
export const EDITOR_MENU_LABEL_KEYS: Record<EditorMenuCommand, EditorMenuLabelKey> = {
  cut: 'editorCut',
  copy: 'editorCopy',
  paste: 'editorPaste',
  selectAll: 'editorSelectAll',
  save: 'editorSave',
  closeTab: 'editorCloseTab',
  closeOthers: 'tabMenuCloseOthers',
  closeLeft: 'tabMenuCloseLeft',
  closeRight: 'tabMenuCloseRight',
  closeAll: 'tabMenuCloseAll',
  wordWrap: 'editorWordWrap',
  mdPreview: 'editorMdPreview',
  format: 'editorFormat',
};

const MAC_SHORTCUTS: Record<EditorMenuCommand, string> = {
  cut: '⌘X',
  copy: '⌘C',
  paste: '⌘V',
  selectAll: '⌘A',
  save: '⌘S',
  closeTab: '⌘W',
  // The batch closes are reachable from the menu only — no key bindings.
  closeOthers: '',
  closeLeft: '',
  closeRight: '',
  closeAll: '',
  wordWrap: '',
  mdPreview: '',
  // Matches the existing keymap binding (`Shift-Alt-f`) and the status bar hint.
  format: 'Shift+Alt+F',
};

const OTHER_SHORTCUTS: Record<EditorMenuCommand, string> = {
  ...MAC_SHORTCUTS,
  cut: 'Ctrl+X',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  selectAll: 'Ctrl+A',
  save: 'Ctrl+S',
  closeTab: 'Ctrl+W',
};

/**
 * Whether the accelerator hints should use the macOS symbols. Anything that is
 * neither Windows nor Linux is treated as macOS, which is the platform this app
 * ships on first.
 */
export function detectMacPlatform(userAgent: string): boolean {
  return !/Windows|Linux/i.test(userAgent);
}

function menuItem(
  command: EditorMenuCommand,
  isMac: boolean,
  disabled = false,
  checked?: boolean,
): EditorMenuItem {
  return {
    kind: 'item',
    command,
    labelKey: EDITOR_MENU_LABEL_KEYS[command],
    shortcut: (isMac ? MAC_SHORTCUTS : OTHER_SHORTCUTS)[command],
    disabled,
    ...(checked === undefined ? {} : { checked }),
  };
}

/**
 * Build the menu for one tab.
 *
 * Ordering puts the text-editing commands up top (what a right-click inside a
 * document is usually for), then selection, then file actions, then the view
 * toggles — the same grouping the main window's menus use.
 */
export function buildEditorMenu(
  ctx: EditorMenuContext,
  isMac: boolean,
): EditorMenuEntry[] {
  const item = (command: EditorMenuCommand, disabled = false, checked?: boolean) =>
    menuItem(command, isMac, disabled, checked);

  // No editor view exists for an image, so every text command would be a no-op.
  // Closing the tab is the only meaningful entry.
  if (ctx.isImage) return [item('closeTab')];

  const entries: EditorMenuEntry[] = [
    item('cut', !ctx.hasSelection),
    item('copy', !ctx.hasSelection),
    item('paste'),
    { kind: 'divider' },
    item('selectAll'),
    { kind: 'divider' },
    item('save'),
    item('closeTab'),
  ];

  const view: EditorMenuItem[] = [item('wordWrap', false, ctx.wrapLines)];
  if (ctx.isMarkdown) view.push(item('mdPreview', false, ctx.previewOpen));
  if (ctx.canFormat) view.push(item('format'));
  entries.push({ kind: 'divider' }, ...view);

  return entries;
}

export interface EditorTabMenuContext {
  /** Zero-based position of the tab that was clicked. */
  tabIndex: number;
  /** How many tabs the strip currently holds. */
  tabCount: number;
}

/**
 * Menu for a right-click on a tab — or on the title bar around the tabs.
 *
 * Same actions in the same order as the window tab strip's menu, so the two
 * rows behave alike. The batch closes are disabled rather than omitted when
 * there is nothing on that side: a greyed row tells you the action exists but
 * does not apply, whereas a missing row just looks like the feature is absent.
 */
export function buildEditorTabMenu(
  ctx: EditorTabMenuContext,
  isMac: boolean,
): EditorMenuEntry[] {
  return [
    menuItem('closeTab', isMac),
    menuItem('closeOthers', isMac, ctx.tabCount <= 1),
    menuItem('closeLeft', isMac, ctx.tabIndex === 0),
    menuItem('closeRight', isMac, ctx.tabIndex === ctx.tabCount - 1),
    { kind: 'divider' },
    menuItem('closeAll', isMac),
  ];
}
