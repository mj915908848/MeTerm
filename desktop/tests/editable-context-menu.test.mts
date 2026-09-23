/**
 * The right-click menu on a form field.
 *
 * A right-click inside an input used to fall through to WKWebView's own menu —
 * Look Up / Translate / Search with Bing / Substitutions / Font / Inspect Element.
 * It showed up on the 添加 JumpServer dialog's server-address box, in the same
 * shape that already took "Reload / Inspect Element" out of the connection window.
 *
 * The app answers with its own four commands instead. These tests pin both halves:
 * the pure model that decides what the menu holds, and the wiring that has to run
 * before anything prevents the default (one preventDefault too early and the
 * WebView menu is gone but the app menu never appears; one too late and both show).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { buildFieldMenu, isFieldInputType } from '../src/editable-menu-model.ts';

const read = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

/** Slice a top-level function out of a module, from its signature to its brace. */
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `signature not found: ${signature}`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `closing brace not found for: ${signature}`);
  return source.slice(start, end);
}

const enabled = (ctx: Parameters<typeof buildFieldMenu>[0]): string[] =>
  buildFieldMenu(ctx)
    .filter((item) => !item.disabled)
    .map((item) => item.command);

// ── The model ──

test('text-carrying inputs count as fields, the rest are left to the platform', () => {
  // No type attribute at all behaves as text, so it must not be skipped.
  for (const type of ['', 'text', 'password', 'search', 'url', 'tel', 'email']) {
    assert.equal(isFieldInputType(type), true, `${type} carries editable text`);
  }
  // These have no text editing to offer — and WKWebView's menu is at least
  // harmless there, unlike on a text box.
  // `number` sits in this list on purpose: it carries no selection at all
  // (`selectionStart` is null, `select()` is a no-op), so a menu whose entries act
  // on a captured selection could not copy, cut or select anything in it, and its
  // paste always landed at the end of the value. The platform's menu works there.
  for (const type of ['checkbox', 'radio', 'file', 'range', 'color', 'button', 'submit', 'hidden', 'number', 'date']) {
    assert.equal(isFieldInputType(type), false, `${type} is not a text field`);
  }
});

test('the menu is cut / copy / paste / select all, in that order', () => {
  assert.deepEqual(
    buildFieldMenu({ hasSelection: true, hasText: true, editable: true }).map((i) => i.command),
    ['cut', 'copy', 'paste', 'selectAll'],
  );
  assert.deepEqual(
    buildFieldMenu({ hasSelection: true, hasText: true, editable: true }).map((i) => i.labelKey),
    ['editorCut', 'editorCopy', 'editorPaste', 'editorSelectAll'],
  );
});

test('an empty field greys out cut and copy, an unfocused one keeps paste', () => {
  assert.deepEqual(enabled({ hasSelection: false, hasText: false, editable: true }), [
    'paste',
  ]);
  assert.deepEqual(enabled({ hasSelection: false, hasText: true, editable: true }), [
    'paste',
    'selectAll',
  ]);
});

// A read-only field is not dead: the JumpServer credential prompt shows the
// account name that way, and copying it out is the whole point of that box.
// Cutting or pasting into it would silently do nothing.
test('a read-only field keeps copy but loses cut and paste', () => {
  assert.deepEqual(enabled({ hasSelection: true, hasText: true, editable: false }), [
    'copy',
    'selectAll',
  ]);
  assert.deepEqual(enabled({ hasSelection: false, hasText: true, editable: false }), [
    'selectAll',
  ]);
});

// ── The wiring ──

test('the main window routes a text field to the app menu', () => {
  const body = fnBody(read('context-menu.ts'), 'export function showCustomContextMenu(');
  const route = body.indexOf('showEditableContextMenu(event, field)');
  assert.ok(route > 0, 'showCustomContextMenu must hand a field to showEditableContextMenu');
  assert.ok(
    body.indexOf('editableFieldAt(target)') > 0,
    'the decision must come from the shared predicate',
  );
  assert.ok(
    route < body.indexOf('event.preventDefault()'),
    'the field branch must run before the terminal branch suppresses the menu outright',
  );
  // The old exception is what let the WebView menu through; it must be gone.
  assert.ok(
    !body.includes('target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement'),
    'inputs must no longer return early and keep the WebView menu',
  );
  assert.ok(
    body.includes('target instanceof HTMLSelectElement'),
    'a dropdown still keeps the platform menu',
  );
});

test('the utility-window suppressor routes fields to the app menu as well', () => {
  const body = fnBody(read('context-menu.ts'), 'export function suppressNativeContextMenu(');
  const route = body.indexOf('showEditableContextMenu(event, field)');
  const suppress = body.indexOf('event.preventDefault()');
  assert.ok(route > 0, 'the suppressor must give fields the app menu, not the WebView one');
  assert.ok(
    route < suppress,
    'the field branch must come before the blanket preventDefault',
  );
  assert.ok(
    body.includes('editableFieldAt(target)'),
    'the suppressor must use the same shared predicate as the main window',
  );
});

// xterm's keyboard textarea lives inside the terminal. Treating it as a form
// field would swap the terminal's menu (copy / paste / split / close session) for
// four text commands.
test("xterm's hidden textarea is never treated as a form field", () => {
  const body = fnBody(read('context-menu.ts'), 'export function editableFieldAt(');
  assert.ok(
    body.includes("'xterm-helper-textarea'"),
    'the helper textarea must be excluded',
  );
  assert.ok(
    body.indexOf('xterm-helper-textarea') < body.indexOf('HTMLInputElement'),
    'the exclusion must be decided before the input branch can claim it',
  );
});

// The remote port box used to be `type="number"` — exactly the type the model
// above refuses to serve — so it was the one field in the app whose right-click
// fell back to the WebView's own English menu. It is a text field with a numeric
// keyboard and a digit filter instead, like the SSH form's port box.
test('the remote port box is a text field, so it keeps the app menu', () => {
  const source = read('remote.ts');
  const start = source.indexOf('const portInput = document.createElement');
  assert.ok(start > 0, 'the remote edit dialog must still build a port field');
  const field = source.slice(start, source.indexOf('portGroup.appendChild(portInput)', start));

  assert.ok(
    field.includes("portInput.type = 'text'"),
    'a number input carries no selection, which is what the model above rules out',
  );
  assert.ok(
    field.includes("portInput.inputMode = 'numeric'"),
    'the numeric keyboard is the one thing the number type was actually providing',
  );
  assert.ok(
    field.includes('replace(/\\D/g'),
    'a text field has to filter its own digits, or the port is no longer a port',
  );
});

// The point of replacing the menu is that the four commands still work. Copy,
// cut and paste have to reach the real clipboard, and paste has to write through
// the `input` event the dialogs listen on.
test('the four commands are wired to the clipboard and to the field', () => {
  const source = read('context-menu.ts');
  const body = fnBody(source, 'export function showEditableContextMenu(');
  assert.ok(body.includes('clipboardWriteText('), 'copy and cut must write the clipboard');
  assert.ok(body.includes('clipboardReadText()'), 'paste must read the clipboard');
  assert.ok(
    body.includes("field.select()"),
    'select all must select the field, not the document',
  );
  // Both the cut and the paste path have to write through the same edit helper,
  // which is what announces the change to the dialog listeners.
  assert.ok(
    body.includes('replaceFieldSelection('),
    'cut and paste must edit the field through the shared helper',
  );
  const edit = fnBody(source, 'function replaceFieldSelection(');
  assert.ok(
    edit.includes("field.dispatchEvent(new Event('input', { bubbles: true }))"),
    'a programmatic edit must announce itself to the dialog listeners',
  );
  assert.ok(
    edit.includes('field.readOnly || field.disabled'),
    'the helper must refuse to edit a field that does not accept edits',
  );
});

// The connections window hosts the same JumpServer dialog (editing a connection
// runs in place there). Without the clipboard permission its copy/paste entries
// would reject.
test('the connection window is allowed to use the clipboard for its fields', () => {
  const capability = fs.readFileSync(
    new URL('../src-tauri/capabilities/connections.json', import.meta.url),
    'utf8',
  );
  assert.ok(
    capability.includes('clipboard-manager:allow-read-text'),
    'paste needs allow-read-text',
  );
  assert.ok(
    capability.includes('clipboard-manager:allow-write-text'),
    'copy needs allow-write-text',
  );
});
