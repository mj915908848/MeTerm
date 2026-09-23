/**
 * editable-menu-model.ts — what the right-click menu on a form field contains.
 *
 * A right-click inside an input or textarea used to fall through to WKWebView's
 * own menu: Look Up / Translate / Search with Bing / Substitutions / Font /
 * Speech / Paragraph Direction / Inspect Element. Those labels come from the
 * system, stay English whatever the app language is, and hand the user a
 * browser's editing model inside a dialog that belongs to this app — the same
 * complaint that already took the "Reload / Inspect Element" menu out of the
 * connection window.
 *
 * The app now answers with its own four entries. *Which* entries, in what order,
 * and which of them are disabled, is decided here; context-menu.ts draws the
 * result. Kept pure so the node test runner — which has no DOM — can check it,
 * the same split editor-menu-model.ts uses.
 */

export type FieldMenuCommand = 'cut' | 'copy' | 'paste' | 'selectAll';

/**
 * The editor window already ships exactly these four labels, and a form field
 * needs exactly these four, so they are shared instead of duplicated. Spelled
 * out as a literal union rather than `string` so a renamed key becomes a compile
 * error at the render site instead of a blank menu row.
 */
export type FieldMenuLabelKey = 'editorCut' | 'editorCopy' | 'editorPaste' | 'editorSelectAll';

/** Single source of truth for the label of each command. */
const LABEL_KEYS: Record<FieldMenuCommand, FieldMenuLabelKey> = {
  cut: 'editorCut',
  copy: 'editorCopy',
  paste: 'editorPaste',
  selectAll: 'editorSelectAll',
};

export interface FieldMenuItem {
  command: FieldMenuCommand;
  /** i18n key, resolved at render time so the menu follows a language change. */
  labelKey: FieldMenuLabelKey;
  disabled: boolean;
}

export interface FieldMenuContext {
  /** Something is selected, so there is text to cut or copy. */
  hasSelection: boolean;
  /** The field holds text, so "select all" would do something. */
  hasText: boolean;
  /**
   * Neither readOnly nor disabled. Cut and paste only make sense on a field that
   * accepts edits; a read-only field (a JumpServer credential prompt shows one)
   * must still offer copy.
   */
  editable: boolean;
}

/**
 * The input types this menu serves: the ones whose text can be selected.
 *
 * `number` is deliberately absent even though the user does type into it. It has
 * no selection API — `selectionStart`/`selectionEnd` are `null`, `setSelectionRange`
 * throws, and `select()` does *nothing* instead of throwing — so a menu that
 * captures a selection before it draws its entries cannot cut, copy or select all
 * in one, and its paste lands at the end of the value wherever the caret was. The
 * platform's own menu at least works there, so that is where those fields are left.
 * Apple's date pickers, checkboxes, radios, file, range, colour and button inputs
 * are left to the platform for the same reason: the app has nothing to add.
 */
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password',
]);

/**
 * Whether an `<input>`'s `type` is one this menu serves.
 *
 * An input without a `type` attribute reports `''` and behaves as text, so the
 * empty string has to count as text — treating it as unknown would silently skip
 * every `<input>` written without an explicit type.
 */
export function isFieldInputType(type: string): boolean {
  return type === '' || TEXT_INPUT_TYPES.has(type.toLowerCase());
}

/**
 * The menu, in the order the platform puts these commands in: cut / copy / paste,
 * then select all.
 *
 * Note the asymmetry: `copy` survives a read-only field (copying a stored
 * password out is exactly what that field is for), while `cut` and `paste` do
 * not — they would silently do nothing.
 */
export function buildFieldMenu(ctx: FieldMenuContext): FieldMenuItem[] {
  const item = (command: FieldMenuCommand, disabled: boolean): FieldMenuItem => ({
    command,
    labelKey: LABEL_KEYS[command],
    disabled,
  });
  return [
    item('cut', !ctx.editable || !ctx.hasSelection),
    item('copy', !ctx.hasSelection),
    item('paste', !ctx.editable),
    item('selectAll', !ctx.hasText),
  ];
}
