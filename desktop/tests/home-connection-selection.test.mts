/**
 * The home page's connection manager: list on the left, selection on the right.
 *
 * What is pinned here is the interaction Jie asked for: on this page a single
 * click only *selects* (connecting on click was too easy to trigger by accident),
 * double-click or Enter connects, ⌘/Ctrl/Shift-click select several and the
 * right pane turns into the batch actions, and an unsaved form is not thrown
 * away without asking.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as selection from '../src/connection-selection.ts';

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
  id = '';
  tabIndex = -1;
  scrollTop = 0;
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
  get isConnected(): boolean { return true; }
  appendChild(el: El): El { el.parent?.removeChild(el); this.children.push(el); el.parent = this; return el; }
  append(...els: El[]): void { for (const el of els) this.appendChild(el); }
  removeChild(el: El): void { this.children = this.children.filter((c) => c !== el); el.parent = null; }
  replaceChildren(...els: El[]): void { for (const c of [...this.children]) this.removeChild(c); this.append(...els); }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  querySelector(): El | null { return null; }
  querySelectorAll(): El[] { return []; }
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(): void {}
  focus(): void {}
}

function findAll(root: El, name: string): El[] {
  const out: El[] = [];
  for (const child of root.children) {
    if (child.className.split(' ').includes(name)) out.push(child);
    out.push(...findAll(child, name));
  }
  return out;
}

const SSH_A = { name: 'web-01', host: '10.0.3.17', port: 22, username: 'root', authMethod: 'key' };
const ITEMS = [
  { type: 'ssh', key: 'ssh:web-01', name: 'web-01', detail: 'root@10.0.3.17:22', raw: SSH_A },
  { type: 'ssh', key: 'ssh:db-01', name: 'db-01', detail: 'dba@10.0.3.30:22', raw: { ...SSH_A, name: 'db-01' } },
];

function boot(options: { confirm?: boolean } = {}) {
  const h = {
    renderCalls: [] as any[],
    connected: [] as string[],
    forms: [] as { prefill: any; dirty: boolean; onSaved: (c: any) => void }[],
    deleted: [] as string[][],
    moved: [] as { keys: string[]; group: string | null }[],
    confirms: 0,
    start: new El(),
    root: null as unknown as El,
  };
  const mocks: Record<string, any> = {
    './i18n': { t: (key: string) => key },
    './app-state': { settings: { language: 'zh' } },
    './overlay-scrollbar': { createOverlayScrollbar: () => {} },
    './home-side': { renderSidebarList: (_l: El, _h: El, query: string, deps: any) => { h.renderCalls.push({ query, deps }); } },
    './home-dashboard-left': {
      collectAllConnections: () => ITEMS,
      createAssetHistoryRow: () => new El(),
      renderRecentActivity: () => {},
      editConnection: () => {},
      escapeHtml: (s: string) => s,
      handleConnectionClick: (item: any) => { h.connected.push(item.key); },
      handleDeleteConnections: async (keys: string[]) => { h.deleted.push([...keys]); },
      showGroupContextMenu: () => {},
      showGroupModal: () => {},
      showMoveMenu: (_a: El, _g: string[], onPick: (g: string | null) => void) => { onPick('prod'); },
    },
    './connection-groups': {
      assignConnectionsToGroup: (keys: string[], group: string | null) => { h.moved.push({ keys: [...keys], group }); },
      createGroup: () => {},
      getJSAssetHistoryByFrequency: () => [],
      loadGroupMap: () => ({}),
      loadGroupOrder: () => ['prod'],
      setGroupColor: () => {},
      sshKey: (name: string) => `ssh:${name}`,
      visibleGroupName: (s: string | undefined) => s ?? null,
    },
    './connection-drag': { attachConnectionDrag: () => () => {} },
    './connection-selection': selection,
    './ssh': {
      createEmbeddedSSHForm: (prefill: any, onSaved: (c: any) => void) => {
        const entry = { prefill, dirty: false, onSaved };
        h.forms.push(entry);
        const el = new El();
        el.className = 'ssh-form-embedded';
        return { el, isDirty: () => entry.dirty };
      },
      loadRecentConnections: () => [],
    },
    '@tauri-apps/plugin-dialog': { confirm: async () => { h.confirms++; return options.confirm ?? false; } },
  };
  const code = ts.transpileModule(
    readFileSync(new URL('../src/home-connection-manager.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } },
  ).outputText;
  const exports: any = {};
  vm.runInNewContext(code, {
    exports,
    Promise,
    CustomEvent: class { type: string; constructor(type: string) { this.type = type; } },
    CSS: { escape: (s: string) => s },
    document: { createElement: () => new El(), dispatchEvent: () => {} },
    requestAnimationFrame: () => 0,
    require: (s: string) => {
      if (!mocks[s]) throw new Error(`unexpected import ${s}`);
      return mocks[s];
    },
  });
  h.root = exports.createConnectionManager(h.start);
  return { h, mod: exports };
}

const deps = (h: any) => h.renderCalls[h.renderCalls.length - 1].deps;
const detail = (h: any): El => findAll(h.root, 'hcm-detail-pane')[0];
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = { toggle: false, range: false };
const visible = ITEMS.map((i) => i.key);

test('with nothing selected the right pane shows the start content', () => {
  const { h } = boot();
  assert.equal(detail(h).children[0], h.start);
});

test('a plain click selects and opens the editor; it does not connect', async () => {
  const { h } = boot();
  assert.equal(deps(h).onRowClick(ITEMS[0], plain, visible), false, 'the list must not run its own connect');
  await flush();
  assert.deepEqual(h.connected, [], 'a click on this page never opens a session');
  assert.equal(deps(h).getSelectedKey(), 'ssh:web-01');
  assert.equal(h.forms.length, 1, 'the SSH form is embedded in the right pane');
  assert.equal(h.forms[0].prefill, SSH_A);
});

test('double-click connects', () => {
  const { h } = boot();
  deps(h).onRowActivate(ITEMS[1]);
  assert.deepEqual(h.connected, ['ssh:db-01']);
});

test('several picked rows turn the right pane into the batch actions', async () => {
  const { h } = boot();
  deps(h).onRowClick(ITEMS[0], plain, visible);
  await flush();
  deps(h).onRowClick(ITEMS[1], { toggle: true, range: false }, visible);
  await flush();
  assert.deepEqual([...deps(h).getSelection()], ['ssh:web-01', 'ssh:db-01']);
  assert.ok(findAll(detail(h), 'hcm-batch-list').length === 1, 'the batch panel lists what is picked');

  const buttons = findAll(detail(h), 'hcm-btn');
  buttons.find((b) => b.textContent === 'connectionMoveToGroup')!.onclick!();
  assert.deepEqual(h.moved, [{ keys: ['ssh:web-01', 'ssh:db-01'], group: 'prod' }], 'one write for the whole batch');

  buttons.find((b) => b.textContent === 'sshDeleteConnection')!.onclick!();
  assert.deepEqual(h.deleted, [['ssh:web-01', 'ssh:db-01']], 'delete covers the whole batch');
});

test('unsaved edits are not thrown away without asking', async () => {
  const { h } = boot({ confirm: false });
  deps(h).onRowClick(ITEMS[0], plain, visible);
  await flush();
  h.forms[0].dirty = true;
  deps(h).onRowClick(ITEMS[1], plain, visible);
  await flush();
  assert.equal(h.confirms, 1, 'switching away from a dirty form asks first');
  assert.equal(deps(h).getSelectedKey(), 'ssh:web-01', 'declining keeps the form and its selection');
  assert.equal(h.forms.length, 1);
});

test('"+ SSH" opens an empty form in the right pane, and saving selects the new connection', async () => {
  const { h } = boot();
  findAll(h.root, 'hcm-btn').find((b) => b.textContent === '+ SSH')!.onclick!();
  await flush();
  assert.equal(h.forms.length, 1);
  assert.equal(h.forms[0].prefill, undefined);
  h.forms[0].onSaved({ name: 'web-01' });
  assert.equal(deps(h).getSelectedKey(), 'ssh:web-01');
});

test('the drawer still connects on a single click', () => {
  const drawer = readFileSync(new URL('../src/connections-drawer.ts', import.meta.url), 'utf8');
  assert.ok(drawer.includes('onSelect: connect'));
  assert.ok(!drawer.includes('onRowClick'), 'no selection rules in the picker');
});
