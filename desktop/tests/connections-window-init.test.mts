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
  placeholder = '';
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

/** Every element whose class list contains `name`, in document order. */
function findAll(root: El, name: string): El[] {
  const found: El[] = [];
  for (const child of root.children) {
    if (child.className.split(' ').includes(name)) found.push(child);
    found.push(...findAll(child, name));
  }
  return found;
}


interface Harness {
  body: El;
  renderCalls: any[];
  dragOptions: any;
  assigned: { keys: string[]; group: string | null }[];
  opened: any[];
  mutated: number;
  modalOpened: number;
  /** Every targeted request this window sent, in order. */
  sent: { target: string; event: string; payload: any }[];
  /** Tauri event listeners the window installed, by event name. */
  listeners: Record<string, Array<(event: any) => void>>;
  /** Window titles it asked for. */
  titles: string[];
  documentElement: { dataset: Record<string, string> };
  /** The settings store a test can change behind `loadSettings()`. */
  settings: { language: string; colorScheme: string };
  store: Map<string, string>;
  /** Items the bridge actually opened a session for. */
  clicked: any[];
  /** Kinds of new-connection dialog the bridge actually started. */
  newActions: string[];
  /** The module under test, so a test can call its other exports. */
  mod: any;
}

function boot(options: { storedOwner?: string; label?: string; liveWindows?: string[] } = {}): Harness {
  const label = options.label ?? 'connections';
  const body = new El();
  const renderCalls: any[] = [];
  const assigned: { keys: string[]; group: string | null }[] = [];
  const opened: any[] = [];
  const clicked: any[] = [];
  const newActions: string[] = [];
  const sent: { target: string; event: string; payload: any }[] = [];
  const listeners: Record<string, Array<(event: any) => void>> = {};
  const titles: string[] = [];
  const documentElement = { dataset: {} as Record<string, string> };
  const settings = { language: 'zh', colorScheme: 'dark' };
  const store = new Map<string, string>();
  if (options.storedOwner) store.set('meterm-connections-owner-window', options.storedOwner);
  /** Stands in for this window's copy of the shared app state. */
  const appState = { language: 'zh' };
  // Written by `setLanguage`, read by `t` — the same split the app has, so a test
  // can tell "the language was applied" from "the language was merely loaded".
  let language = 'zh';
  const harness: Harness = {
    body, renderCalls, dragOptions: null, assigned, opened, mutated: 0, modalOpened: 0,
    sent, listeners, titles, documentElement, settings, store, clicked, newActions, mod: null,
  };

  const groups: Record<string, string> = { 'ssh:a': 'prod' };
  const items = [
    { type: 'ssh', key: 'ssh:a', name: 'a', detail: 'root@a:22', raw: {} },
    { type: 'ssh', key: 'ssh:b', name: 'b', detail: 'root@b:22', raw: {} },
  ];

  const mocks: Record<string, any> = {
    '@tauri-apps/api/core': {
      invoke: async (command: string, args: any) => {
        assert.equal(command, 'connections_dispatch');
        const request = args.request;
        if (request.action === 'mutated') {
          sent.push({ target: '*', event: 'connections-mutated', payload: undefined });
          harness.mutated++;
          return null;
        }
        const live = options.liveWindows ?? ['main', 'window-42', 'window-7'];
        const target = live.includes(request.preferredOwner) ? request.preferredOwner
          : live.includes('main') ? 'main' : live.find((name) => name.startsWith('window-'));
        if (!target) throw new Error('no app window is available');
        const event = request.action === 'open' ? 'connections-open-request' : 'connections-new-request';
        const payload = request.action === 'open'
          ? { type: request.connectionType, key: request.key, targetWindowLabel: target }
          : { kind: request.kind, targetWindowLabel: target };
        sent.push({ target, event, payload });
        if (event === 'connections-open-request') opened.push(payload);
        return target;
      },
    },
    '@tauri-apps/api/window': {
      getCurrentWindow: () => ({
        label,
        show: async () => {},
        setFocus: async () => {},
        close: async () => {},
        startDragging: async () => {},
        setTitle: async (title: string) => { titles.push(title); },
      }),
    },
    '@tauri-apps/api/webviewWindow': {
      WebviewWindow: { getByLabel: async () => null },
    },
    '@tauri-apps/api/event': {
      // A request is addressed to one window; a broadcast is not. Both are recorded
      // so a test can tell which one this window used.
      emit: (event: string, payload: any) => {
        sent.push({ target: '*', event, payload });
        if (event === 'connections-open-request') opened.push(payload);
        if (event === 'connections-mutated') harness.mutated++;
      },
      emitTo: (target: string, event: string, payload: any) => {
        sent.push({ target, event, payload });
        if (event === 'connections-open-request') opened.push(payload);
        if (event === 'connections-mutated') harness.mutated++;
      },
      listen: async (event: string, handler: (event: any) => void) => {
        (listeners[event] ??= []).push(handler);
        return () => {};
      },
    },
    './i18n': {
      initLanguage: () => {},
      setLanguage: (next: string) => { language = next; },
      t: (key: string) => `${language}:${key}`,
    },
    './themes': { loadSettings: () => ({ ...settings }), resolveIsDark: () => true },
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
      handleConnectionClick: (item: any) => { clicked.push(item); },
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
      // Stub of the real one: a `__` name is the app's own bookkeeping, never a
      // group a user can see (see connection-groups.ts). The move path compares a
      // row's group through it, so a mock without it throws where the real helper
      // returns null.
      visibleGroupName: (stored: string | null | undefined) =>
        (typeof stored === 'string' && !stored.startsWith('__') ? stored : null),
    },
    './connection-drag': {
      attachConnectionDrag: (_list: El, options: any) => { harness.dragOptions = options; return () => {}; },
    },
    './connection-selection': selection,
    './ssh': { setSSHConnectHandler: () => {} },
    './remote': { setRemoteConnectHandler: () => {} },
    './connection-sidebar': {
      makeNewButtons: () => new El(),
      runNewConnectionAction: (kind: string) => { newActions.push(kind); },
    },
    './nb-palette': { applyNbPalette: () => {} },
    './app-state': {
      // `L()` inside the window reads the language from here, so the mock has to
      // follow `setSettings` rather than sit at its initial value.
      setSettings: (next: { language?: string }) => { if (next.language) appState.language = next.language; },
      settings: appState,
      isWindowsPlatform: false,
      isLinuxPlatform: false,
    },
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
      documentElement,
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    // Shared across this app's windows in the real thing: the opener writes the
    // owner here and the window it creates reads it while it initialises.
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: unknown) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
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
  harness.mod = exports;
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

// ── Which window the requests go to ──
//
// The launcher is a singleton but the windows that can open it are not, so every
// request names the window it is for — the one that opened the launcher last. The
// source-level half of this contract is in connections-window-routing.test.mts;
// what follows is what the window actually sends.

const sampleItem = { type: 'ssh', key: 'ssh:a', name: 'a', detail: '', raw: {} };

test('a request is addressed to the window the launcher belongs to', () => {
  const h = boot({ storedOwner: 'window-42' });
  h.renderCalls[0].deps.onSelect(sampleItem);

  assert.equal(h.sent.length, 1, 'one request, sent once');
  assert.equal(h.sent[0].target, 'window-42', 'not the first window — the one that opened this launcher');
  assert.equal(
    h.sent[0].payload.targetWindowLabel,
    'window-42',
    'and it says so in the payload, which is what the receiving window checks',
  );
});

test('a closed launcher owner falls back to the live main window', () => {
  const h = boot({ storedOwner: 'window-42', liveWindows: ['main'] });
  h.renderCalls[0].deps.onSelect(sampleItem);
  assert.equal(h.sent[0].target, 'main');
  assert.equal(h.sent[0].payload.targetWindowLabel, 'main');
});

test('when main is also gone, the launcher finds another live app window', () => {
  const h = boot({ storedOwner: 'window-42', liveWindows: ['window-7'] });
  h.renderCalls[0].deps.onSelect(sampleItem);
  assert.equal(h.sent[0].target, 'window-7');
  assert.equal(h.sent[0].payload.targetWindowLabel, 'window-7');
});

test('a launcher nobody claimed falls back to the startup window', () => {
  const h = boot();
  h.renderCalls[0].deps.onSelect(sampleItem);
  assert.equal(h.sent[0].target, 'main', 'requests went to the startup window before there was an owner, and still do');
});

test('an already-open launcher is re-pointed by the window that reuses it', () => {
  const h = boot({ storedOwner: 'main' });
  h.listeners['connections-owner-claim'].forEach((handler) => handler({ payload: { owner: 'window-7' } }));
  h.renderCalls[0].deps.onSelect(sampleItem);

  assert.equal(
    h.sent[0].target,
    'window-7',
    'the store is read once at startup, so a takeover has to arrive as an event',
  );
});

test('a claim that cannot name a window is refused', () => {
  const h = boot();
  const claim = h.listeners['connections-owner-claim'];
  for (const owner of ['connections', 'not a label!', '', 42, null, undefined]) {
    claim.forEach((handler) => handler({ payload: { owner } }));
    claim.forEach((handler) => handler({ payload: null }));
  }
  h.renderCalls[0].deps.onSelect(sampleItem);

  assert.equal(
    h.sent[0].target,
    'main',
    'a launcher that owned itself, or a label no window can have, must never become the target',
  );
});

// ── Which window may act on a request ──
//
// The bridge is registered in *every* app window, because any window can own the
// launcher. That only works if the receiving side checks who a request is for —
// otherwise one click in the launcher starts one session per open window, which is
// a worse bug than the one it replaced. connections-window-routing.test.mts reads
// that guard out of the source; this is the half that would really open the second
// session, so it drives the installed listeners.

test('a request addressed to another window is not acted on', async () => {
  const h = boot({ label: 'window-5' });
  h.mod.setupConnectionsWindowBridge();
  const [open] = h.listeners['connections-open-request'];

  await open({ payload: { type: 'ssh', key: 'ssh:a', targetWindowLabel: 'window-9' } });
  assert.equal(h.clicked.length, 0, 'a window the request does not name has to stay out of it');

  await open({ payload: { type: 'ssh', key: 'ssh:a', targetWindowLabel: 'window-5' } });
  assert.equal(h.clicked.length, 1, 'the named window is the one that opens the session');
  assert.equal(h.clicked[0].key, 'ssh:a', 'and it opens the connection the request names');
});

test('a new-connection request is addressed as well', async () => {
  const h = boot({ label: 'window-5' });
  h.mod.setupConnectionsWindowBridge();
  const [start] = h.listeners['connections-new-request'];

  await start({ payload: { kind: 'ssh', targetWindowLabel: 'window-9' } });
  assert.deepEqual(h.newActions, [], 'one click must not open the same dialog in every window');

  await start({ payload: { kind: 'ssh', targetWindowLabel: 'window-5' } });
  assert.deepEqual(h.newActions, ['ssh']);
});

// ── Settings that arrive after the chrome was built ──

test('a language change reaches the chrome that was built once', () => {
  const h = boot();
  assert.equal(
    find(h.body, 'home-side-search-input')!.placeholder,
    'zh:homeSearchPlaceholder',
    'the chrome is written in the language that was current when it was created',
  );

  h.settings.language = 'en';
  h.listeners['settings-changed'].forEach((handler) => handler({ payload: null }));

  assert.equal(
    find(h.body, 'home-side-search-input')!.placeholder,
    'en:homeSearchPlaceholder',
    'including its aria-label and placeholder, which no re-render would rebuild',
  );
  assert.equal(find(h.body, 'cn-new-group')!.textContent, '+ en:homeGroupNew');
  assert.equal(find(h.body, 'cn-footer')!.textContent, 'en:connectionsWindowHint');

  const [move, clear] = findAll(h.body, 'cn-selbar-btn');
  assert.equal(move.textContent, 'en:connectionMoveToGroup');
  assert.equal(clear.textContent, 'en:connectionClearSelection');

  assert.equal(
    h.titles[h.titles.length - 1],
    'en:connectionsWindowTitle',
    'the window title follows the language as well',
  );
});

test('a theme change reaches the document element', () => {
  const h = boot();
  assert.equal(h.documentElement.dataset.theme, 'dark', 'the window opens on the saved theme');

  h.settings.colorScheme = 'light';
  h.listeners['settings-changed'].forEach((handler) => handler({ payload: null }));

  assert.equal(
    h.documentElement.dataset.theme,
    'light',
    'switching the theme in the settings window has to move this window with it',
  );
});
