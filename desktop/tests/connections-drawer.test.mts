/**
 * The connections drawer, opened and driven end to end.
 *
 * The drawer replaced a standalone connections window. It lives in the window
 * whose sessions it opens, so a pick is a local call — and the window, with its
 * cross-window routing, must not come back by accident. It only *picks*:
 * managing connections is the home page's job, so the drawer has no row menu,
 * no multi-select and no dragging. The rest pins how it gets out of the way: a
 * connect, a new-connection dialog, Escape, an outside click and a new tab all
 * close it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

type Listener = (event: any) => void;

class El {
  children: El[] = [];
  parent: El | null = null;
  innerHTML = '';
  textContent = '';
  title = '';
  placeholder = '';
  type = '';
  value = '';
  hidden = false;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  onclick?: (event?: any) => void;
  listeners: Record<string, Listener[]> = {};
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
  get isConnected(): boolean { return this.parent !== null; }
  appendChild(el: El): El { this.children.push(el); el.parent = this; return el; }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  getAttribute(key: string): string | null { return this.attrs[key] ?? null; }
  querySelector(): El | null { return null; }
  querySelectorAll(): El[] { return []; }
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(): void {}
  getBoundingClientRect() { return { top: 41, left: 0, width: 900, height: 600 }; }
  focused = 0;
  focus(): void { this.focused++; }
  blur(): void {}
}

function find(root: El, name: string): El | null {
  for (const child of root.children) {
    if (child.className.split(' ').includes(name)) return child;
    const nested = find(child, name);
    if (nested) return nested;
  }
  return null;
}

interface Harness {
  mod: any;
  body: El;
  renderCalls: any[];
  clicked: any[];
  newActions: string[];
  homeShown: number;
  docListeners: Record<string, Listener[]>;
  newButtonsPick: ((kind: string) => void) | null;
  docKeyListeners: Listener[];
  tabListeners: Array<() => void>;
  tabs: unknown[];
  /** Selector the drawer asks about to decide if a dialog sits above it. */
  overlayOpen: boolean;
  terminal: El;
}

function boot(): Harness {
  const body = new El();
  const terminal = new El();
  new El().appendChild(terminal);
  const h: Harness = {
    mod: null, body, renderCalls: [], clicked: [], newActions: [], homeShown: 0, docListeners: {},
    newButtonsPick: null, docKeyListeners: [], tabListeners: [], tabs: [],
    overlayOpen: false, terminal,
  };
  const items = [
    { type: 'ssh', key: 'ssh:a', name: 'a', detail: 'root@a:22', raw: {} },
    { type: 'ssh', key: 'ssh:b', name: 'b', detail: 'root@b:22', raw: {} },
  ];

  const mocks: Record<string, any> = {
    './i18n': { t: (key: string) => key },
    './overlay-scrollbar': { createOverlayScrollbar: () => {} },
    './home-side': {
      renderSidebarList: (_list: El, _slot: El, query: string, deps: any) => { h.renderCalls.push({ query, deps }); },
    },
    './home-dashboard-left': {
      collectAllConnections: () => items,
      handleConnectionClick: (item: any) => { h.clicked.push(item); },
    },
    './view-manager': { showHomeView: () => { h.homeShown++; } },
    './tab-renderer': { renderTabs: () => {} },
    './connection-sidebar': {
      makeNewButtons: (onPick: (kind: string) => void) => { h.newButtonsPick = onPick; return new El(); },
      runNewConnectionAction: (kind: string) => {
        // The dialog must not open underneath a drawer that is still there.
        assert.equal(h.mod.isConnectionsDrawerOpen(), false, 'the drawer closes before the dialog opens');
        h.newActions.push(kind);
      },
    },
    './tabs': {
      TabManager: {
        get tabs() { return h.tabs; },
        subscribe: (fn: () => void) => {
          h.tabListeners.push(fn);
          return () => { h.tabListeners = h.tabListeners.filter((l) => l !== fn); };
        },
      },
    },
    './app-state': { settings: { language: 'zh' } },
  };

  const code = ts.transpileModule(
    read('src/connections-drawer.ts'),
    // ES2021 like the app build: at ES5, `[...picked]` on a Set comes back empty.
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } },
  ).outputText;

  const exports: any = {};
  vm.runInNewContext(code, {
    exports,
    HTMLElement: El,
    Promise,
    document: {
      createElement: () => new El(),
      getElementById: (id: string) => (id === 'main-content' ? new El() : null),
      body,
      get activeElement() { return terminal; },
      addEventListener: (type: string, fn: Listener) => {
        if (type === 'keydown') h.docKeyListeners.push(fn);
        else (h.docListeners[type] ??= []).push(fn);
      },
      removeEventListener: (type: string, fn: Listener) => {
        if (type === 'keydown') h.docKeyListeners = h.docKeyListeners.filter((l) => l !== fn);
      },
      querySelector: (selector: string) => (selector.includes('.ssh-modal-overlay') && h.overlayOpen ? new El() : null),
    },
    window: { addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 900, innerHeight: 640 },
    requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
    console,
    require: (specifier: string) => {
      if (!mocks[specifier]) throw new Error(`unexpected import ${specifier}`);
      return mocks[specifier];
    },
  });
  h.mod = exports;
  return h;
}

const root = (h: Harness): El | null => find(h.body, 'cn-drawer-root');
const pressEscape = (h: Harness): void => {
  for (const fn of [...h.docKeyListeners]) {
    fn({ key: 'Escape', isComposing: false, preventDefault() {}, stopPropagation() {} });
  }
};

test('the toolbar button toggles the drawer open and closed', () => {
  const h = boot();
  h.mod.toggleConnectionsDrawer();
  assert.ok(root(h), 'the drawer is mounted');
  assert.equal(root(h)!.style.top, '41px', 'it sits over the main content, below the toolbar');
  assert.ok(root(h)!.classList.contains('is-open'));
  assert.equal(h.renderCalls.length, 1, 'the list renders once on open');

  h.mod.toggleConnectionsDrawer();
  assert.equal(root(h), null, 'a second press closes it');
  assert.equal(h.mod.isConnectionsDrawerOpen(), false);
  assert.ok(h.terminal.focused > 0, 'focus goes back to where it was (the terminal)');
  assert.equal(h.docKeyListeners.length, 0, 'its Escape handler leaves with it');
});

test('picking a connection opens it here and closes the drawer', () => {
  const h = boot();
  h.mod.openConnectionsDrawer();
  const deps = h.renderCalls[0].deps;
  deps.onSelect({ type: 'ssh', key: 'ssh:a', name: 'a', detail: '', raw: {} });
  assert.deepEqual(h.clicked.map((i) => i.key), ['ssh:a'], 'the session opens in this window, directly');
  assert.equal(root(h), null);
});

test('the drawer only picks: no row menu, no multi-select, no dragging', () => {
  const h = boot();
  h.mod.openConnectionsDrawer();
  const deps = h.renderCalls[0].deps;
  assert.equal(deps.rowMenu, false, 'editing and deleting happen on the home page');
  assert.equal(deps.onRowClick, undefined, 'a click always connects');
  assert.equal(deps.onGroupContextMenu, undefined);
  assert.equal(find(h.body, 'cn-selbar'), null);
  const source = read('src/connections-drawer.ts');
  assert.ok(!source.includes('attachConnectionDrag'), 'rows are not draggable here');
});

test('"manage connections" closes the drawer and opens the home page', async () => {
  const h = boot();
  h.mod.openConnectionsDrawer();
  find(h.body, 'cn-manage')!.onclick!();
  assert.equal(root(h), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.homeShown, 1);
});

test('an edit saved elsewhere re-renders an open drawer', () => {
  const h = boot();
  h.mod.setupConnectionsDrawerSync();
  h.mod.openConnectionsDrawer();
  for (const fn of h.docListeners['ssh-connections-changed']) fn({});
  assert.equal(h.renderCalls.length, 2);
});

test('a new-connection button closes the drawer before its dialog opens', () => {
  const h = boot();
  h.mod.openConnectionsDrawer();
  h.newButtonsPick!('ssh');
  assert.deepEqual(h.newActions, ['ssh']);
  assert.equal(root(h), null);
});

test('Escape closes the drawer, unless a dialog opened from it is on top', () => {
  const h = boot();
  h.mod.openConnectionsDrawer();
  h.overlayOpen = true;
  pressEscape(h);
  assert.ok(root(h), 'Escape belongs to the edit dialog');
  h.overlayOpen = false;
  pressEscape(h);
  assert.equal(root(h), null);
});

test('clicking outside the panel closes the drawer', () => {
  const h = boot();
  h.mod.openConnectionsDrawer();
  const scrim = find(h.body, 'cn-drawer-scrim')!;
  for (const fn of scrim.listeners.pointerdown) fn({ button: 0 });
  assert.equal(root(h), null);
});

test('a session started from an edit dialog closes the drawer too', () => {
  const h = boot();
  h.mod.openConnectionsDrawer();
  h.tabs.push({});
  for (const fn of [...h.tabListeners]) fn();
  assert.equal(root(h), null);
  assert.equal(h.tabListeners.length, 0, 'the subscription leaves with the drawer');
});

// ── Wiring ──

test('the toolbar button and ⌘⇧O / Ctrl+Shift+O open the drawer', () => {
  const toolbar = read('src/toolbar.ts');
  assert.ok(toolbar.includes('connBtn.onclick = () => { toggleConnectionsDrawer(); };'));
  const shortcuts = read('src/keyboard-shortcuts.ts');
  assert.match(shortcuts, /key === 'o' && event\.shiftKey[\s\S]{0,200}toggleConnectionsDrawer\(\)/);
  assert.ok(
    shortcuts.indexOf("key === 'o' && event.shiftKey") < shortcuts.indexOf('if (!isMac) {'),
    'the shortcut must work while the terminal has focus on Windows, like PiP',
  );
});

test('the standalone connections window is gone for good', () => {
  assert.equal(existsSync(new URL('../src/connections-window.ts', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src-tauri/capabilities/connections.json', import.meta.url)), false);
  assert.ok(!read('src/main.ts').includes("'connections'"), 'no ?window=connections route');
  assert.ok(!read('src/window-utils.ts').includes('window=connections'));
  assert.ok(!read('src-tauri/src/commands/window.rs').includes('window=connections'));
  assert.ok(!read('src-tauri/src/lib.rs').includes('connections_dispatch'));
});
