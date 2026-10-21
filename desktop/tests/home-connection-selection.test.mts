/**
 * The home page's connection table, with an inspector for the selection.
 *
 * What is pinned here is the interaction Jie asked for: on this page a single
 * click only *selects* (connecting on click was too easy to trigger by accident)
 * and shows the connection read-only in the inspector; "edit" opens its form.
 * Double-click, Enter or the row's "connect" button connects, ⌘/Ctrl/Shift-click
 * select several and the inspector turns into the batch actions, column headers
 * sort, group chips filter, and an unsaved form is not thrown away without asking.
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
  ondblclick?: (event?: any) => void;
  oncontextmenu?: (event?: any) => void;
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
  getBoundingClientRect() { return { left: 0, bottom: 0 }; }
  closest(): El | null { return null; }
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
const SSH_B = { name: 'db-01', host: '10.0.3.30', port: 2222, username: 'dba', authMethod: 'password' };
const JS = { name: 'bastion', sshHost: 'jms.local', sshPort: 2222, username: 'ops', baseUrl: 'https://jms.local', authMethod: 'password' };
const ITEMS = [
  { type: 'ssh', key: 'ssh:web-01', name: 'web-01', detail: 'root@10.0.3.17:22', raw: SSH_A },
  { type: 'ssh', key: 'ssh:db-01', name: 'db-01', detail: 'dba@10.0.3.30:2222', raw: SSH_B },
  { type: 'jumpserver', key: 'js:bastion', name: 'bastion', detail: 'ops@jms.local:2222', raw: JS },
];

function boot(options: { confirm?: boolean; groups?: Record<string, string> } = {}) {
  const store = new Map<string, string>();
  const h = {
    connected: [] as string[],
    forms: [] as { prefill: any; dirty: boolean; onSaved: (c: any) => void }[],
    deleted: [] as string[][],
    moved: [] as { keys: string[]; group: string | null }[],
    confirms: 0,
    menu: [] as { label: string; onPick: () => void; danger?: boolean }[],
    rowMenus: [] as any[],
    actions: [] as string[],
    root: null as unknown as El,
    search: new El(),
  };
  const groups = options.groups ?? { 'ssh:web-01': 'prod' };
  const mocks: Record<string, any> = {
    './i18n': { t: (key: string) => key },
    './app-state': { settings: { language: 'zh' } },
    './home-dashboard-left': {
      collectAllConnections: () => ITEMS,
      createAssetHistoryRow: () => new El(),
      editConnection: () => {},
      escapeHtml: (s: string) => s,
      filterConnections: (items: any[], q: string) => (q ? items.filter((i) => i.name.includes(q)) : items),
      handleConnectionClick: (item: any) => { h.connected.push(item.key); },
      handleDeleteConnections: async (keys: string[]) => { h.deleted.push([...keys]); },
      loadConnectionLastUsed: () => ({ 'ssh:db-01': Date.now() - 5 * 60000 }),
      showActionMenu: (_a: El, entries: any[]) => { h.menu = entries; },
      showConnectionContextMenu: (...args: any[]) => { h.rowMenus.push(args); },
      showGroupContextMenu: () => {},
      showGroupModal: () => {},
      showMoveMenu: (_a: El, _g: string[], onPick: (g: string | null) => void) => { onPick('prod'); },
    },
    './connection-groups': {
      assignConnectionsToGroup: (keys: string[], group: string | null) => { h.moved.push({ keys: [...keys], group }); },
      createGroup: () => {},
      getJSAssetHistoryByFrequency: () => [],
      loadGroupColors: () => ({ prod: '#22c55e' }),
      loadGroupMap: () => groups,
      loadGroupOrder: () => ['prod'],
      setGroupColor: () => {},
      sshKey: (name: string) => `ssh:${name}`,
      visibleGroupName: (s: string | undefined) => s ?? null,
    },
    './connection-drag': { attachConnectionDrag: () => () => {}, UNGROUPED_DROP_GROUP: '__ungrouped__' },
    './connection-selection': selection,
    './connection-sidebar': { runNewConnectionAction: (kind: string) => { h.actions.push(kind); } },
    './icons': { icon: (name: string) => `<svg data-icon="${name}"></svg>` },
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
    Date,
    CustomEvent: class { type: string; constructor(type: string) { this.type = type; } },
    CSS: { escape: (s: string) => s },
    document: { createElement: () => new El(), dispatchEvent: () => {} },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
    requestAnimationFrame: () => 0,
    require: (s: string) => {
      if (!mocks[s]) throw new Error(`unexpected import ${s}`);
      return mocks[s];
    },
  });
  h.root = exports.createConnectionManager({ searchRow: new El(), searchInput: h.search });
  return { h, mod: exports };
}

const rows = (h: any): El[] => findAll(h.root, 'hcm-row');
const rowNamed = (h: any, key: string): El => rows(h).find((r) => r.dataset.key === key)!;
const names = (h: any): string[] => rows(h).map((r) => r.dataset.key);
const inspector = (h: any): El => findAll(h.root, 'hcm-inspector')[0];
const buttonIn = (root: El, label: string): El => findAll(root, 'ssh-btn').find((b) => b.textContent === label)!;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const click = (el: El, mods: any = {}) => el.onclick!({ metaKey: false, ctrlKey: false, shiftKey: false, stopPropagation() {}, ...mods });

test('every connection, JumpServer included, is a row; nothing is selected and the inspector is closed', () => {
  const { h } = boot();
  assert.deepEqual(names(h), ['js:bastion', 'ssh:db-01', 'ssh:web-01'], 'sorted by name');
  assert.equal(inspector(h).children.length, 0);
  assert.ok(!h.root.classList.contains('has-inspector'));
});

test('a plain click selects and opens the inspector; it does not connect', async () => {
  const { h } = boot();
  click(rowNamed(h, 'ssh:web-01'));
  await flush();
  assert.deepEqual(h.connected, [], 'a click on this page never opens a session');
  assert.ok(h.root.classList.contains('has-inspector'));
  assert.equal(h.forms.length, 0, 'a selection opens the read-only view, not the form');
  assert.equal(findAll(inspector(h), 'hcm-facts').length, 1);
  assert.ok(rowNamed(h, 'ssh:web-01').classList.contains('selected'));

  buttonIn(inspector(h), 'sshConnectBtn').onclick!();
  assert.deepEqual(h.connected, ['ssh:web-01'], 'the inspector\'s connect button opens it');
});

test('double-click and the row\'s connect button connect', () => {
  const { h } = boot();
  rowNamed(h, 'ssh:db-01').ondblclick!({ target: new El() });
  click(findAll(rowNamed(h, 'js:bastion'), 'hcm-row-connect')[0]);
  assert.deepEqual(h.connected, ['ssh:db-01', 'js:bastion']);
});

test('the close button closes the inspector', async () => {
  const { h } = boot();
  click(rowNamed(h, 'ssh:web-01'));
  await flush();
  findAll(inspector(h), 'hcm-icon-btn').find((b) => b.title === '关闭')!.onclick!();
  await flush();
  assert.ok(!h.root.classList.contains('has-inspector'));
});

test('"edit" swaps in the form, and cancel or save goes back to the view', async () => {
  const { h, mod } = boot();
  click(rowNamed(h, 'ssh:web-01'));
  await flush();
  buttonIn(inspector(h), 'homeEditConnection').onclick!();
  await flush();
  assert.equal(h.forms.length, 1, 'the SSH form is embedded in the inspector');
  assert.equal(h.forms[0].prefill, SSH_A);

  buttonIn(inspector(h), '取消').onclick!();
  await flush();
  assert.equal(findAll(inspector(h), 'ssh-form-embedded').length, 0);

  buttonIn(inspector(h), 'homeEditConnection').onclick!();
  await flush();
  h.forms[1].onSaved({ name: 'web-01' });
  mod.refreshConnectionManager(); // what the save's 'ssh-connections-changed' does in the app
  assert.equal(findAll(inspector(h), 'hcm-facts').length, 1, 'saving returns to the view');
});

test('a column header sorts, and a second click reverses', () => {
  const { h } = boot();
  const header = (col: string) => findAll(h.root, 'hcm-th').find((th) => th.dataset.col === col)!;
  header('used').onclick!();
  assert.equal(names(h)[0], 'ssh:db-01', 'the most recently used first');
  header('address').onclick!();
  assert.deepEqual(names(h), ['ssh:web-01', 'ssh:db-01', 'js:bastion']);
  header('address').onclick!();
  assert.deepEqual(names(h), ['js:bastion', 'ssh:db-01', 'ssh:web-01']);
});

test('group and JumpServer chips filter the rows; clicking again shows all', () => {
  const { h } = boot();
  const chip = (text: string) => findAll(h.root, 'hcm-chip').find((c) => c.innerHTML.includes(`<span>${text}</span>`))!;
  click(chip('prod'));
  assert.deepEqual(names(h), ['ssh:web-01']);
  click(chip('prod'));
  assert.equal(names(h).length, 3);
  click(chip('JumpServer'));
  assert.deepEqual(names(h), ['js:bastion']);
  click(chip('homeGroupUngrouped'));
  assert.deepEqual(names(h), ['js:bastion', 'ssh:db-01']);
});

test('the search box filters the table', () => {
  const { h } = boot();
  h.search.value = 'db';
  for (const fn of h.search.listeners.input) fn({});
  assert.deepEqual(names(h), ['ssh:db-01']);
});

test('several picked rows turn the inspector into the batch actions', async () => {
  const { h } = boot();
  click(rowNamed(h, 'ssh:web-01'));
  await flush();
  click(rowNamed(h, 'ssh:db-01'), { metaKey: true });
  await flush();
  assert.ok(findAll(inspector(h), 'hcm-batch-list').length === 1, 'the batch panel lists what is picked');
  buttonIn(inspector(h), 'connectionMoveToGroup').onclick!();
  assert.deepEqual(h.moved, [{ keys: ['ssh:web-01', 'ssh:db-01'], group: 'prod' }], 'one write for the whole batch');
  buttonIn(inspector(h), 'sshDeleteConnection').onclick!();
  assert.equal(h.deleted.length, 1);
  assert.deepEqual([...h.deleted[0]].sort(), ['ssh:db-01', 'ssh:web-01']);
});

test('unsaved edits are not thrown away without asking', async () => {
  const { h } = boot({ confirm: false });
  click(rowNamed(h, 'ssh:web-01'));
  await flush();
  buttonIn(inspector(h), 'homeEditConnection').onclick!();
  await flush();
  h.forms[0].dirty = true;
  click(rowNamed(h, 'ssh:db-01'));
  await flush();
  assert.equal(h.confirms, 1, 'switching away from a dirty form asks first');
  assert.ok(rowNamed(h, 'ssh:web-01').classList.contains('selected'), 'declining keeps the form and its selection');
});

test('"+ new" offers SSH, JumpServer and a group; SSH opens an empty form in the inspector', async () => {
  const { h } = boot();
  findAll(h.root, 'ssh-btn').find((b) => b.textContent === '+ 新建')!.onclick!();
  assert.deepEqual([...h.menu.map((m) => m.label)], ['SSH 连接', 'JumpServer', '分组']);
  h.menu[1].onPick();
  assert.deepEqual(h.actions, ['jumpserver']);
  h.menu[0].onPick();
  await flush();
  assert.equal(h.forms.length, 1);
  assert.equal(h.forms[0].prefill, undefined);
});

test('right-click opens the row menu; over a multi-selection it carries the batch', async () => {
  const { h } = boot();
  click(rowNamed(h, 'ssh:web-01'));
  await flush();
  click(rowNamed(h, 'ssh:db-01'), { metaKey: true });
  await flush();
  rowNamed(h, 'ssh:db-01').oncontextmenu!({ preventDefault() {} });
  assert.deepEqual([...h.rowMenus[0][5]], ['ssh:web-01', 'ssh:db-01']);
});

test('the drawer still connects on a single click', () => {
  const drawer = readFileSync(new URL('../src/connections-drawer.ts', import.meta.url), 'utf8');
  assert.ok(drawer.includes('onSelect: connect'));
  assert.ok(!drawer.includes('onRowClick'), 'no selection rules in the picker');
});
