/**
 * The connection window's own chrome, built end to end.
 *
 * The window is created by the main window and only then runs its init: a throw
 * anywhere in there is a blank window with no console attached, which is the
 * failure mode this whole file exists to prevent. It also pins the wiring that a
 * source-reading test cannot — that a plain click still opens a session, that a
 * modified click only selects, and that a drop moves the whole selection in one
 * write.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as selection from '../src/connection-selection.ts';

class El {
  children: El[] = [];
  innerHTML = '';
  textContent = '';
  title = '';
  type = '';
  value = '';
  hidden = false;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  style: any = { setProperty() {} };
  onclick?: (event?: any) => void;
  #classes = new Set<string>();
  classList = {
    add: (c: string) => { this.#classes.add(c); },
    remove: (c: string) => { this.#classes.delete(c); },
    toggle: (c: string, force?: boolean) => {
      const on = force === undefined ? !this.#classes.has(c) : force;
      if (on) this.#classes.add(c); else this.#classes.delete(c);
      return on;
    },
    contains: (c: string) => this.#classes.has(c),
  };
  get className(): string { return [...this.#classes].join(' '); }
  set className(value: string) { this.#classes = new Set(value.split(/\s+/).filter(Boolean)); }
  appendChild(el: El): El { this.children.push(el); return el; }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  getAttribute(key: string): string | null { return this.attrs[key] ?? null; }
  querySelector(): El { return new El(); }
  querySelectorAll(): El[] { return []; }
  addEventListener(): void {}
  removeEventListener(): void {}
  focus(): void {}
  blur(): void {}
}

/** Depth-first search for an element whose class list contains `name`. */
function find(root: El, name: string): El | null {
  for (const child of root.children) {
    if (child.className.split(' ').includes(name)) return child;
    const nested = find(child, name);
    if (nested) return nested;
  }
  return null;
}


interface Harness {
  body: El;
  renderCalls: any[];
  dragOptions: any;
  assigned: { keys: string[]; group: string | null }[];
  opened: any[];
  mutated: number;
  modalOpened: number;
}

function boot(): Harness {
  const body = new El();
  const renderCalls: any[] = [];
  const assigned: { keys: string[]; group: string | null }[] = [];
  const opened: any[] = [];
  const harness: Harness = {
    body, renderCalls, dragOptions: null, assigned, opened, mutated: 0, modalOpened: 0,
  };

  const groups: Record<string, string> = { 'ssh:a': 'prod' };
  const items = [
    { type: 'ssh', key: 'ssh:a', name: 'a', detail: 'root@a:22', raw: {} },
    { type: 'ssh', key: 'ssh:b', name: 'b', detail: 'root@b:22', raw: {} },
  ];

  const mocks: Record<string, any> = {
    '@tauri-apps/api/window': {
      getCurrentWindow: () => ({ label: 'connections', show: async () => {}, setFocus: async () => {}, close: async () => {}, startDragging: async () => {} }),
    },
    '@tauri-apps/api/webviewWindow': {
      WebviewWindow: { getByLabel: async () => null },
    },
    '@tauri-apps/api/event': {
      emit: (event: string, payload: any) => {
        if (event === 'connections-open-request') opened.push(payload);
        if (event === 'connections-mutated') harness.mutated++;
      },
      listen: async () => () => {},
    },
    './i18n': { initLanguage: () => {}, setLanguage: () => {}, t: (key: string) => key },
    './themes': { loadSettings: () => ({ language: 'zh', colorScheme: 'dark' }), resolveIsDark: () => true },
    './window-utils': { createUtilityWindow: async () => {}, revealAfterPaint: async () => {} },
    './overlay-scrollbar': { createOverlayScrollbar: () => {} },
    './notify': { showToast: () => {} },
    './context-menu': { suppressNativeContextMenu: () => {} },
    './home-side': {
      renderSidebarList: (_list: El, _slot: El, query: string, deps: any) => {
        renderCalls.push({ query, deps });
      },
      // Exported by home-side.ts and re-exported for reuse; not exercised here.
      loadPinned: () => new Set(),
    },
    './home-dashboard-left': {
      collectAllConnections: () => items,
      editConnection: () => {},
      findConnectionItem: () => undefined,
      handleConnectionClick: () => {},
      setEditConnectDelegate: () => {},
      showGroupContextMenu: () => {},
      showGroupModal: () => { harness.modalOpened++; },
    },
    './connection-groups': {
      assignConnectionsToGroup: (keys: string[], group: string | null) => { assigned.push({ keys: [...keys], group }); },
      createGroup: () => {},
      loadGroupMap: () => groups,
      loadGroupOrder: () => ['prod'],
      setGroupColor: () => {},
    },
    './connection-drag': {
      attachConnectionDrag: (_list: El, options: any) => { harness.dragOptions = options; return () => {}; },
    },
    './connection-selection': selection,
    './ssh': { setSSHConnectHandler: () => {} },
    './remote': { setRemoteConnectHandler: () => {} },
    './connection-sidebar': { makeNewButtons: () => new El(), runNewConnectionAction: () => {} },
    './nb-palette': { applyNbPalette: () => {} },
    './app-state': { setSettings: () => {}, settings: { language: 'zh' }, isWindowsPlatform: false, isLinuxPlatform: false },
  };

  const code = ts.transpileModule(
    readFileSync(new URL('../src/connections-window.ts', import.meta.url), 'utf8'),
    // Target matters: at the ES5 default TS downlevels `[...picked]` into
    // `__spreadArray(..., pack)` which reads `.length` — undefined on a Set — so a
    // spread of the selection silently comes back empty. The app itself builds at
    // ES2021, so the harness has to as well.
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } },
  ).outputText;

  const exports: any = {};
  vm.runInNewContext(code, {
    exports,
    document: {
      createElement: () => new El(),
      getElementById: () => new El(),
      body,
      documentElement: { dataset: {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: { addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 400, innerHeight: 640 },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    require: (specifier: string) => {
      if (!mocks[specifier]) throw new Error(`unexpected import ${specifier}`);
      return mocks[specifier];
    },
  });

  exports.initConnectionsWindow();
  return harness;
}

test('the window boots without throwing', () => {
  const h = boot();
  assert.equal(h.renderCalls.length, 1, 'the list must be rendered once on open');
});

test('search and "new group" open the window with a group entry point', () => {
  const h = boot();
  assert.ok(find(h.body, 'cn-toolbar'), 'search and the group button share a row');
  assert.ok(find(h.body, 'cn-new-group'), 'the window needs its own way to create a group');
  assert.ok(find(h.body, 'cn-selbar'), 'the selection bar is part of the chrome');
});

test('the selection bar stays hidden until something is picked', () => {
  const h = boot();
  assert.equal(find(h.body, 'cn-selbar')!.hidden, true, 'an empty selection has nothing to act on');
});

test('a plain click opens the connection, a modified click only selects', () => {
  const h = boot();
  const deps = h.renderCalls[0].deps;
  const item = { type: 'ssh', key: 'ssh:a', name: 'a', detail: '', raw: {} };
  const visible = ['ssh:a', 'ssh:b'];

  const connect = deps.onRowClick(item, { toggle: false, range: false }, visible);
  assert.equal(connect, true, 'clicking a connection must still open it');
  assert.equal(h.opened.length, 0, 'opening is the caller\'s job, not the row handler\'s');

  assert.equal(deps.onRowClick(item, { toggle: true, range: false }, visible), false);
  assert.equal(find(h.body, 'cn-selbar')!.hidden, false, 'picking a row must reveal the actions');
  assert.equal(deps.isRowSelected('ssh:a'), true);
  assert.equal(deps.isRowSelected('ssh:b'), false);
});

test('a drop moves the whole selection in one write and clears it', () => {
  const h = boot();
  const deps = h.renderCalls[0].deps;
  const visible = ['ssh:a', 'ssh:b'];
  const b = { type: 'ssh', key: 'ssh:b', name: 'b', detail: '', raw: {} };
  const c = { type: 'ssh', key: 'ssh:c', name: 'c', detail: '', raw: {} };
  assert.equal(deps.onRowClick(b, { toggle: true, range: false }, visible), false);
  assert.equal(deps.onRowClick(c, { toggle: true, range: false }, visible), false);

  // The drag controller is told what is picked, and hands the drop back.
  assert.deepEqual([...h.dragOptions.getSelection()], ['ssh:b', 'ssh:c']);
  assert.equal(h.dragOptions.dragLabel(2), '2 个连接', 'the ghost reports how many rows are moving');
  assert.equal(h.dragOptions.dragLabel(1), '1 个连接');

  h.dragOptions.onDrop('prod', [...h.dragOptions.getSelection()]);

  assert.equal(h.assigned.length, 1, 'one write, not one per row');
  assert.deepEqual(h.assigned[0], { keys: ['ssh:b', 'ssh:c'], group: 'prod' });
  assert.equal(find(h.body, 'cn-selbar')!.hidden, true, 'the selection is spent once it has moved');
  assert.equal(deps.isRowSelected('ssh:b'), false);
});

test('dropping a row back where it already is changes nothing', () => {
  const h = boot();
  const deps = h.renderCalls[0].deps;
  deps.onRowClick({ type: 'ssh', key: 'ssh:a', name: 'a', detail: '', raw: {} }, { toggle: true, range: false }, ['ssh:a']);
  h.dragOptions.onDrop('prod', ['ssh:a']);
  assert.deepEqual(h.assigned, [], 'a no-op drop must not write, re-render, or emit');
  assert.equal(h.mutated, 0);
});

/**
 * Three controls can move picked rows — the toolbar button, a drag onto a group
 * header, and now the row's own context menu. They must agree on what is picked.
 *
 * Only the last one asks through `getSelection`, and nothing checked that it was
 * handed over: the row menu used to fall back to the row under the cursor while
 * the button beside it moved the whole selection, so the same selection looked
 * broken depending on which control the user reached for.
 */
test('the row menu is handed the same selection the toolbar and drag see', () => {
  const h = boot();
  const deps = h.renderCalls[0].deps;
  const visible = ['ssh:a', 'ssh:b', 'ssh:c'];
  const b = { type: 'ssh', key: 'ssh:b', name: 'b', detail: '', raw: {} };
  const c = { type: 'ssh', key: 'ssh:c', name: 'c', detail: '', raw: {} };

  assert.equal(typeof deps.getSelection, 'function', 'the list needs a way to ask what is picked');
  assert.deepEqual([...deps.getSelection()], [], 'nothing is picked on open');

  assert.equal(deps.onRowClick(b, { toggle: true, range: false }, visible), false);
  assert.equal(deps.onRowClick(c, { toggle: true, range: false }, visible), false);

  const viaMenu = [...deps.getSelection()];
  const viaDrag = [...h.dragOptions.getSelection()];
  assert.deepEqual(viaMenu, ['ssh:b', 'ssh:c']);
  assert.deepEqual(viaMenu, viaDrag, 'the row menu and the drag controller must not disagree');
});
