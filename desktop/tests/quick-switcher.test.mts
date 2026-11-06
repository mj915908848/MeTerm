/**
 * The connection quick switcher (⌘⇧O), opened and driven end to end.
 *
 * It replaced the connections list docked on the left, which repeated the home
 * page's grouped list. The switcher only finds a connection: favourites and
 * recent first, type to narrow, Enter connects, ⌘E edits; managing connections
 * stays on the home page.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

type Listener = (event: any) => void;
let activeEl: El | null = null;

class El {
  children: El[] = [];
  parent: El | null = null;
  innerHTML = '';
  textContent = '';
  title = '';
  placeholder = '';
  type = '';
  value = '';
  id = '';
  tabIndex = 0;
  spellcheck = true;
  autocomplete = '';
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  onclick?: (event?: any) => void;
  onmousedown?: (event?: any) => void;
  onmousemove?: (event?: any) => void;
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
  get childElementCount(): number { return this.children.length; }
  appendChild(el: El): El { this.children.push(el); el.parent = this; return el; }
  append(...els: El[]): void { for (const el of els) this.appendChild(el); }
  replaceChildren(): void { for (const c of this.children) c.parent = null; this.children = []; }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
  querySelectorAll(selector: string): El[] { return findAll(this, selector.replace(/^\./, '')); }
  scrollIntoView(): void {}
  focus(): void { activeEl = this; }
  fire(type: string, event: any): void { for (const fn of this.listeners[type] ?? []) fn(event); }
}

function findAll(root: El, cls: string, out: El[] = []): El[] {
  for (const child of root.children) {
    if (child.classList.contains(cls)) out.push(child);
    findAll(child, cls, out);
  }
  return out;
}
const find = (root: El, cls: string): El | null => findAll(root, cls)[0] ?? null;

const items = [
  { type: 'ssh', key: 'ssh:prod-web', name: 'prod-web', detail: 'root@10.0.0.1:22', raw: {} },
  { type: 'ssh', key: 'ssh:db', name: 'db', detail: 'root@10.0.0.2:22', raw: {} },
  { type: 'ssh', key: 'ssh:staging-prod', name: 'staging-prod', detail: 'root@10.0.0.3:22', raw: {} },
  { type: 'jumpserver', key: 'jumpserver:jump', name: 'jump', detail: 'me@jump:2222', raw: {} },
];

function boot(opts: { pinned?: string[]; recent?: string[] } = {}) {
  const body = new El();
  const terminal = new El();
  body.appendChild(terminal);
  activeEl = terminal;
  const h = {
    mod: null as any,
    body,
    terminal,
    clicked: [] as any[],
    edited: [] as any[],
    newActions: [] as string[],
    homeShown: 0,
    tabListeners: [] as Array<() => void>,
    tabs: [] as unknown[],
    activeTabId: 't1',
    docListeners: {} as Record<string, Listener[]>,
  };
  const pinned = new Set(opts.pinned ?? []);
  const mocks: Record<string, any> = {
    './i18n': { t: (key: string) => key },
    './icons': { icon: () => '' },
    './app-state': { settings: { language: 'zh' } },
    './home-dashboard-left': {
      collectAllConnections: () => items,
      filterConnections: (list: any[], q: string) => list.filter((i) => i.name.includes(q) || i.detail.includes(q)),
      escapeHtml: (s: string) => s,
      handleConnectionClick: (item: any) => { h.clicked.push(item); },
      editConnection: (item: any) => {
        assert.equal(h.mod.isQuickSwitcherOpen(), false, 'the switcher closes before the dialog opens');
        h.edited.push(item);
      },
    },
    './connection-pins': { isPinned: (key: string) => pinned.has(key) },
    './connection-groups': {
      loadGroupMap: () => ({ 'ssh:prod-web': '生产' }),
      sshKey: (name: string) => `ssh:${name}`,
      visibleGroupName: (s: string | undefined) => s ?? null,
    },
    './ssh': { loadRecentConnections: () => (opts.recent ?? []).map((name) => ({ name })) },
    './connection-sidebar': {
      runNewConnectionAction: (kind: string) => {
        assert.equal(h.mod.isQuickSwitcherOpen(), false, 'the switcher closes before the dialog opens');
        h.newActions.push(kind);
      },
    },
    './tabs': {
      TabManager: {
        get tabs() { return h.tabs; },
        get activeTabId() { return h.activeTabId; },
        subscribe: (fn: () => void) => {
          h.tabListeners.push(fn);
          return () => { h.tabListeners = h.tabListeners.filter((l) => l !== fn); };
        },
      },
    },
    './view-manager': { showHomeView: () => { h.homeShown++; } },
    './tab-renderer': { renderTabs: () => {} },
  };
  const code = ts.transpileModule(read('src/quick-switcher.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports: any = {};
  vm.runInNewContext(code, {
    exports,
    HTMLElement: El,
    Promise,
    navigator: { userAgent: 'Macintosh' },
    document: {
      createElement: () => new El(),
      body,
      get activeElement() { return activeEl; },
      querySelector: () => null,
      addEventListener: (type: string, fn: Listener) => { (h.docListeners[type] ??= []).push(fn); },
    },
    console,
    require: (specifier: string) => {
      if (!mocks[specifier]) throw new Error(`unexpected import ${specifier}`);
      return mocks[specifier];
    },
  });
  h.mod = exports;
  return h;
}

const root = (h: ReturnType<typeof boot>) => find(h.body, 'qs-overlay');
const input = (h: ReturnType<typeof boot>) => find(h.body, 'qs-input')!;
const key = (h: ReturnType<typeof boot>, k: string, mods: Record<string, boolean> = {}) =>
  input(h).fire('keydown', { key: k, isComposing: false, preventDefault() {}, stopPropagation() {}, ...mods });
const type = (h: ReturnType<typeof boot>, text: string) => { input(h).value = text; input(h).fire('input', {}); };
const rowNames = (h: ReturnType<typeof boot>) =>
  findAll(h.body, 'qs-row').map((r) => (r.innerHTML.match(/qs-name">([^<]*)</) ?? [])[1]);
const sectionTitles = (h: ReturnType<typeof boot>) => findAll(h.body, 'qs-section').map((s) => s.textContent);

test('opening focuses the search box; toggling again closes and hands focus back', () => {
  const h = boot();
  h.mod.toggleQuickSwitcher();
  assert.ok(root(h));
  assert.equal(activeEl, input(h));
  h.mod.toggleQuickSwitcher();
  assert.equal(root(h), null);
  assert.equal(activeEl, h.terminal);
});

test('with no query: favourites, then recent, then the rest, then the actions', () => {
  const h = boot({ pinned: ['ssh:db'], recent: ['jump', 'prod-web', 'db', 'gone'] });
  h.mod.openQuickSwitcher();
  assert.deepEqual(sectionTitles(h), ['收藏', '最近使用', '其他连接']);
  // Pinned db; then recent prod-web ("jump" is a JumpServer config, not an SSH
  // recent; db is already shown; "gone" is no longer saved); then the rest.
  assert.deepEqual(rowNames(h), ['db', 'prod-web', 'staging-prod', 'jump', '新建 SSH 连接…', '去首页管理连接']);
});

test('typing ranks names that start with the query first', () => {
  const h = boot();
  h.mod.openQuickSwitcher();
  type(h, 'prod');
  assert.deepEqual(rowNames(h).slice(0, 2), ['prod-web', 'staging-prod']);
  assert.equal(rowNames(h).at(-2), '新建 SSH 连接…', 'the actions stay under the matches');
});

test('Enter connects the highlighted row and closes', () => {
  const h = boot();
  h.mod.openQuickSwitcher();
  type(h, 'prod');
  key(h, 'ArrowDown');
  key(h, 'Enter');
  assert.deepEqual(h.clicked.map((i) => i.name), ['staging-prod']);
  assert.equal(root(h), null);
});

test('⌘E edits the highlighted connection in its dialog', () => {
  const h = boot();
  h.mod.openQuickSwitcher();
  type(h, 'db');
  key(h, 'e', { metaKey: true });
  assert.deepEqual(h.edited.map((i) => i.name), ['db']);
  assert.deepEqual(h.clicked, [], 'editing does not connect');
});

test('the actions open a new SSH dialog or the home page', async () => {
  const h = boot();
  h.mod.openQuickSwitcher();
  type(h, 'zzz');
  key(h, 'Enter');
  assert.deepEqual(h.newActions, ['ssh']);
  h.mod.openQuickSwitcher();
  type(h, 'zzz');
  key(h, 'ArrowDown');
  key(h, 'Enter');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.homeShown, 1);
});

test('Escape clears the query first, then closes', () => {
  const h = boot();
  h.mod.openQuickSwitcher();
  type(h, 'db');
  key(h, 'Escape');
  assert.ok(root(h));
  assert.equal(input(h).value, '');
  key(h, 'Escape');
  assert.equal(root(h), null);
});

test('a click on the backdrop closes; a new tab or a tab switch closes too', () => {
  const h = boot();
  h.mod.openQuickSwitcher();
  const overlay = root(h)!;
  overlay.fire('mousedown', { target: overlay, preventDefault() {} });
  assert.equal(root(h), null);

  h.mod.openQuickSwitcher();
  h.tabs.push({});
  for (const fn of [...h.tabListeners]) fn();
  assert.equal(root(h), null);
  assert.equal(h.tabListeners.length, 0, 'the subscription leaves with the switcher');
});

test('the toolbar button and ⌘⇧O / Ctrl+Shift+O open the switcher', () => {
  const toolbar = read('src/toolbar.ts');
  assert.ok(toolbar.includes('connBtn.onclick = () => { toggleQuickSwitcher(); };'));
  const shortcuts = read('src/keyboard-shortcuts.ts');
  assert.match(shortcuts, /key === 'o' && event\.shiftKey[\s\S]{0,200}toggleQuickSwitcher\(\)/);
  assert.ok(
    shortcuts.indexOf("key === 'o' && event.shiftKey") < shortcuts.indexOf('if (!isMac) {'),
    'the shortcut must work while the terminal has focus on Windows',
  );
});

test('the docked connections list and the standalone window are gone', () => {
  assert.equal(existsSync(new URL('../src/connections-drawer.ts', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/connections-window.ts', import.meta.url)), false);
  assert.ok(!read('src/main.ts').includes("'connections'"), 'no ?window=connections route');
});
