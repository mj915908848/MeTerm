import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EDITOR_MENU_LABEL_KEYS,
  buildEditorMenu,
  buildEditorTabMenu,
  detectMacPlatform,
  type EditorMenuContext,
  type EditorMenuEntry,
  type EditorMenuItem,
} from '../src/editor-menu-model.ts';

/** Everything a normal, selected, formattable, non-markdown text tab has. */
const baseCtx: EditorMenuContext = {
  isImage: false,
  hasSelection: true,
  isMarkdown: false,
  wrapLines: false,
  previewOpen: false,
  canFormat: false,
};

const build = (over: Partial<EditorMenuContext> = {}, isMac = true): EditorMenuEntry[] =>
  buildEditorMenu({ ...baseCtx, ...over }, isMac);

const commands = (entries: EditorMenuEntry[]): string[] =>
  entries.filter((e): e is EditorMenuItem => e.kind === 'item').map(e => e.command);

const find = (entries: EditorMenuEntry[], command: string): EditorMenuItem => {
  const item = entries.find(
    (e): e is EditorMenuItem => e.kind === 'item' && e.command === command,
  );
  assert.ok(item, `expected a menu item for "${command}"`);
  return item;
};

const hasCommand = (entries: EditorMenuEntry[], command: string): boolean =>
  commands(entries).includes(command);

// ── Shape ──

test('an image tab offers only Close Tab, since it has no editor view', () => {
  const entries = build({ isImage: true });
  assert.deepEqual(commands(entries), ['closeTab']);
});

test('a text tab exposes the full editing set', () => {
  assert.deepEqual(commands(build()), [
    'cut', 'copy', 'paste', 'selectAll', 'save', 'closeTab', 'wordWrap',
  ]);
});

test('markdown adds the preview toggle; plain text does not', () => {
  assert.ok(!hasCommand(build(), 'mdPreview'));
  assert.ok(hasCommand(build({ isMarkdown: true }), 'mdPreview'));
});

test('format appears only when the language is formattable', () => {
  assert.ok(!hasCommand(build(), 'format'));
  assert.ok(hasCommand(build({ canFormat: true }), 'format'));
});

// ── Enablement ──

test('cut and copy are disabled without a selection, but paste stays usable', () => {
  const entries = build({ hasSelection: false });
  assert.equal(find(entries, 'cut').disabled, true);
  assert.equal(find(entries, 'copy').disabled, true);
  assert.equal(find(entries, 'paste').disabled, false);
});

test('cut and copy are enabled once something is selected', () => {
  const entries = build({ hasSelection: true });
  assert.equal(find(entries, 'cut').disabled, false);
  assert.equal(find(entries, 'copy').disabled, false);
});

test('anything that cannot run in an image tab is absent rather than disabled', () => {
  const entries = build({ isImage: true, hasSelection: true });
  for (const command of ['cut', 'copy', 'paste', 'selectAll', 'save', 'wordWrap']) {
    assert.ok(!hasCommand(entries, command), `"${command}" should not be reachable`);
  }
});

// ── Toggle state ──

test('wrap and preview report their current state so the menu can show a check', () => {
  const off = build({ isMarkdown: true, wrapLines: false, previewOpen: false });
  assert.equal(find(off, 'wordWrap').checked, false);
  assert.equal(find(off, 'mdPreview').checked, false);

  const on = build({ isMarkdown: true, wrapLines: true, previewOpen: true });
  assert.equal(find(on, 'wordWrap').checked, true);
  assert.equal(find(on, 'mdPreview').checked, true);
});

test('commands that are not toggles never carry a checked flag', () => {
  const entries = build({ canFormat: true, isMarkdown: true });
  for (const command of ['cut', 'copy', 'paste', 'selectAll', 'save', 'closeTab', 'format']) {
    assert.equal(find(entries, command).checked, undefined, `${command} is not a toggle`);
  }
});

// ── Shortcuts ──

test('accelerator hints follow the platform', () => {
  const mac = build({}, true);
  assert.equal(find(mac, 'copy').shortcut, '⌘C');
  assert.equal(find(mac, 'save').shortcut, '⌘S');

  const other = build({}, false);
  assert.equal(find(other, 'copy').shortcut, 'Ctrl+C');
  assert.equal(find(other, 'save').shortcut, 'Ctrl+S');
});

test('the shortcut strings do not leak macOS symbols onto other platforms', () => {
  for (const entry of build({}, false)) {
    if (entry.kind !== 'item') continue;
    assert.ok(!entry.shortcut.includes('⌘'), `${entry.command} kept a macOS symbol`);
  }
});

test('toggles have no accelerator, since they are bound to none', () => {
  const entries = build({ isMarkdown: true });
  assert.equal(find(entries, 'wordWrap').shortcut, '');
  assert.equal(find(entries, 'mdPreview').shortcut, '');
});

test('only Windows and Linux are treated as non-mac', () => {
  assert.equal(detectMacPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), true);
  assert.equal(detectMacPlatform('Mozilla/5.0 (Linux; x86_64)'), false);
  assert.equal(detectMacPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), false);
  // WKWebView's UA can be reduced; an unknown platform should still get the
  // macOS symbols rather than "Ctrl+", which would be wrong on every Mac.
  assert.equal(detectMacPlatform('MeTerm'), true);
});

// ── Divider hygiene ──

test('dividers never lead, trail, or sit next to each other', () => {
  const cases: EditorMenuContext[] = [
    { ...baseCtx, isImage: true },
    baseCtx,
    { ...baseCtx, isMarkdown: true, canFormat: true },
  ];
  for (const ctx of cases) {
    const entries = buildEditorMenu(ctx, true);
    assert.notEqual(entries[0]?.kind, 'divider');
    assert.notEqual(entries[entries.length - 1]?.kind, 'divider');
    for (let i = 1; i < entries.length; i++) {
      const pairIsDouble = entries[i].kind === 'divider' && entries[i - 1].kind === 'divider';
      assert.equal(pairIsDouble, false, `double divider at index ${i}`);
    }
  }
});

// ── Label keys ──

test('every label key is spelled once and shared across commands', () => {
  const keys = Object.values(EDITOR_MENU_LABEL_KEYS);
  assert.equal(new Set(keys).size, keys.length);
  // The renderer resolves these through t(); a typo would surface as a blank
  // label rather than a failure, so pin the expected set here.
  assert.deepEqual([...keys].sort(), [
    'editorCloseTab', 'editorCopy', 'editorCut', 'editorFormat', 'editorMdPreview',
    'editorPaste', 'editorSave', 'editorSelectAll', 'editorWordWrap',
    'tabMenuCloseAll', 'tabMenuCloseLeft', 'tabMenuCloseOthers', 'tabMenuCloseRight',
  ]);
});

// ── Tab menu (right-click on a tab or the title bar) ──

const tabMenu = (tabIndex: number, tabCount: number): EditorMenuEntry[] =>
  buildEditorTabMenu({ tabIndex, tabCount }, true);

test('the tab menu offers the same closes as the window tab strip', () => {
  assert.deepEqual(commands(tabMenu(1, 3)), [
    'closeTab', 'closeOthers', 'closeLeft', 'closeRight', 'closeAll',
  ]);
});

test('close-others is disabled when the tab is the only one', () => {
  assert.equal(find(tabMenu(0, 1), 'closeOthers').disabled, true);
  assert.equal(find(tabMenu(0, 2), 'closeOthers').disabled, false);
});

test('close-left is disabled only on the first tab', () => {
  assert.equal(find(tabMenu(0, 3), 'closeLeft').disabled, true);
  assert.equal(find(tabMenu(1, 3), 'closeLeft').disabled, false);
  assert.equal(find(tabMenu(2, 3), 'closeLeft').disabled, false);
});

test('close-right is disabled only on the last tab', () => {
  assert.equal(find(tabMenu(2, 3), 'closeRight').disabled, true);
  assert.equal(find(tabMenu(0, 3), 'closeRight').disabled, false);
  assert.equal(find(tabMenu(1, 3), 'closeRight').disabled, false);
});

test('close-tab and close-all stay available even with a single tab', () => {
  const only = tabMenu(0, 1);
  assert.equal(find(only, 'closeTab').disabled, false);
  assert.equal(find(only, 'closeAll').disabled, false);
});

test('the tab menu never offers document commands', () => {
  const entries = tabMenu(0, 2);
  for (const command of ['cut', 'copy', 'paste', 'selectAll', 'save', 'wordWrap', 'format']) {
    assert.ok(!hasCommand(entries, command), `"${command}" belongs to the document menu`);
  }
});

test('batch closes advertise no accelerator while close-tab keeps its own', () => {
  const entries = tabMenu(0, 2);
  for (const command of ['closeOthers', 'closeLeft', 'closeRight', 'closeAll']) {
    assert.equal(find(entries, command).shortcut, '');
  }
  assert.equal(find(entries, 'closeTab').shortcut, '⌘W');

  const windows = buildEditorTabMenu({ tabIndex: 0, tabCount: 2 }, false);
  assert.equal(find(windows, 'closeTab').shortcut, 'Ctrl+W');
});

test('the divider separates the tab-targeted closes from the global one', () => {
  const entries = tabMenu(1, 3);
  const dividerAt = entries.findIndex((e) => e.kind === 'divider');
  assert.equal(dividerAt, 4);
  assert.deepEqual(
    commands(entries.slice(0, dividerAt)),
    ['closeTab', 'closeOthers', 'closeLeft', 'closeRight'],
  );
  assert.deepEqual(commands(entries.slice(dividerAt + 1)), ['closeAll']);
});
