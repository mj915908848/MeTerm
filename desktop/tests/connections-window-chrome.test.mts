/**
 * Window chrome of the connection window.
 *
 * A utility window that registers no `contextmenu` handler gets WKWebView's own
 * menu on right-click — "Reload" and "Inspect Element". Only the main window
 * replaces the menu with the app's own (showCustomContextMenu), so every other
 * window showed that browser menu the moment the user right-clicked anything the
 * app itself does not handle: a dialog, empty list space, a footer.
 *
 * The rows are not the problem — they call preventDefault themselves and show the
 * app menu. What is left is everything else, hence one document-level guard per
 * window.
 *
 * Text fields are not an exception to that guard; they are routed to the app's
 * editing menu (see editable-context-menu.test.mts). Only a dropdown keeps the
 * platform menu.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

/** Slice from `start` up to the first top-level closing brace line. */
function bodyAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} was not found`);
  return source.slice(start, source.indexOf('\n}\n', start));
}

test('the connection window suppresses the WebView context menu', () => {
  const source = read('connections-window.ts');
  assert.match(
    source,
    /import\s*\{[^}]*suppressNativeContextMenu[^}]*\}\s*from\s*'\.\/context-menu'/,
    'the connection window must import the suppressor',
  );
  assert.ok(
    bodyAfter(source, 'export function initConnectionsWindow').includes('suppressNativeContextMenu()'),
    'initConnectionsWindow must install the suppressor, or right-clicking shows a browser menu',
  );
});

test('the suppressor answers fields itself instead of letting the WebView do it', () => {
  const body = bodyAfter(read('context-menu.ts'), 'export function suppressNativeContextMenu');
  assert.ok(
    body.includes('editableFieldAt(target)'),
    'a text field has to be recognised, not waved through to the WebView menu',
  );
  assert.ok(
    body.includes('HTMLSelectElement'),
    'a dropdown is the one element that keeps the platform menu',
  );
  assert.ok(
    /event\.preventDefault\(\)/.test(body),
    'everything else must be prevented, which is what hides the WebView menu',
  );
  // Field handling must come first, or fields fall into the blanket preventDefault
  // and lose their menu entirely.
  assert.ok(
    body.indexOf('editableFieldAt') < body.indexOf('preventDefault'),
    'the field branch must be checked before preventing',
  );
});

test('the main window keeps its own handler rather than gaining a second one', () => {
  const source = read('event-listeners.ts');
  assert.ok(
    source.includes("document.addEventListener('contextmenu', showCustomContextMenu)"),
    'the main window replaces the menu with the app menu — it must not also suppress it outright',
  );
});
