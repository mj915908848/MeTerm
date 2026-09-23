/**
 * Utility windows must never answer a right-click with WKWebView's own menu.
 *
 * This keeps coming back one window at a time: the connection window showed
 * "Reload / Inspect Element", then the editor window, then the 添加 JumpServer
 * dialog, and now the settings window. The cause is always the same — `main.ts`
 * returns early for `?window=...`, so only the main window ever runs
 * `setupDomEventListeners()`, and a window that registers nothing of its own
 * falls through to the WebView's menu. That menu is a browser's: English
 * whatever the app language is, and "Reload" discards whatever the user was
 * working on.
 *
 * So the check is per route, not per file: the list below has to name every
 * `?window=` label `main.ts` can take, and the route test fails when a new one
 * appears without being covered. The connection window's own guard lives in
 * connections-window-chrome.test.mts; the field menu's behaviour lives in
 * editable-context-menu.test.mts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const readCapability = (name: string): string =>
  fs.readFileSync(new URL(`../src-tauri/capabilities/${name}`, import.meta.url), 'utf8');

/** Slice from `marker` up to the first top-level closing brace line. */
function bodyAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} was not found`);
  return source.slice(start, source.indexOf('\n}\n', start));
}

/** Every `?window=` label main.ts routes on. A new one has to be added here. */
const WINDOW_ROUTES = [
  'about',
  'connections',
  'editor',
  'jumpserver-browser',
  'settings',
  'updater',
];

test('every utility-window route is listed here, so a new window cannot slip through', () => {
  const found = [...read('main.ts').matchAll(/params\.get\('window'\) === '([^']+)'/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(
    found,
    [...WINDOW_ROUTES].sort(),
    'a window route was added or removed — cover it in this file before changing the list',
  );
});

// The three windows that answer with the app's own menu (or with nothing at all):
// none of them shows a browser menu on a slider, a button, the tab strip, or
// empty space. They all sit under capabilities/default.json, so the clipboard
// entries the field menu needs are already granted there.
const SUPPRESSED: Array<[file: string, init: string]> = [
  ['settings-window.ts', 'export function initSettingsWindow'],
  ['about-window.ts', 'export function initAboutWindow'],
  ['updater-window.ts', 'export function initUpdaterWindow'],
];

test('the settings, about and updater windows install the shared suppressor', () => {
  for (const [file, init] of SUPPRESSED) {
    const source = read(file);
    assert.match(
      source,
      /import\s*\{[^}]*suppressNativeContextMenu[^}]*\}\s*from\s*'\.\/context-menu'/,
      `${file} must import the suppressor`,
    );
    assert.ok(
      bodyAfter(source, init).includes('suppressNativeContextMenu()'),
      `${init} must call it, or a right-click shows the WebView's Reload / Inspect Element`,
    );
  }
});

// The menu's four commands have to actually work. They reach the clipboard
// through the Tauri plugin, which is per-capability: a window that installs the
// suppressor without the permission would show cut / copy / paste / select all
// and have every copy and paste reject.
test('each of those windows is allowed to use the clipboard for its fields', () => {
  for (const label of ['settings', 'about', 'updater']) {
    const owner = fs
      .readdirSync(new URL('../src-tauri/capabilities/', import.meta.url))
      .find((name) =>
        new RegExp(`"windows"\\s*:\\s*\\[[^\\]]*"${label}"`).test(readCapability(name)),
      );
    assert.ok(owner, `no capability file covers the ${label} window`);
    const text = readCapability(owner);
    assert.ok(
      text.includes('clipboard-manager:allow-read-text'),
      `${owner} needs allow-read-text or paste rejects in the ${label} window`,
    );
    assert.ok(
      text.includes('clipboard-manager:allow-write-text'),
      `${owner} needs allow-write-text or copy rejects in the ${label} window`,
    );
  }
});

// The editor window answers right-clicks with its own document menu (file
// actions on the body, tab actions on the tab strip). It is the one utility
// window with a handler of its own rather than the shared suppressor.
test('the editor window registers its own document-level menu', () => {
  assert.ok(
    read('file-editor.ts').includes("document.addEventListener('contextmenu', openEditorContextMenu)"),
    'the editor window must keep its own contextmenu handler',
  );
});

// The JumpServer asset window is the one route still left on the platform menu:
// it is an untrusted sub-window, and its capability grants no clipboard access,
// so the shared suppressor would hand it four entries that all reject. If it
// ever moves to the app menu, this fails until the capability follows.
test('the JumpServer asset window does not take the app menu without the clipboard', () => {
  const suppresses = read('jumpserver-browser-window.ts').includes('suppressNativeContextMenu');
  const capability = readCapability('jumpserver-browser.json');
  const allowsClipboard =
    capability.includes('clipboard-manager:allow-read-text') &&
    capability.includes('clipboard-manager:allow-write-text');
  assert.ok(
    !suppresses || allowsClipboard,
    'jumpserver-browser.json must gain the clipboard permissions before this window uses the app menu',
  );
});
