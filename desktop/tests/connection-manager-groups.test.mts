/**
 * The connection manager's list, as the grouping feature needs it.
 *
 * Four invariants that the drag-and-drop UI depends on and that are easy to
 * break by accident:
 *
 *   1. A named group renders even when it holds nothing. It is the drop target a
 *      user creates one moment before dragging rows into it — hiding it makes the
 *      group they just made look like it never happened.
 *   2. Every row carries its key and its group on the DOM node. The drag
 *      controller is delegated (the list is re-rendered wholesale), so it has no
 *      other way to know what it is holding.
 *   3. A plain click still connects. Selection is what the modifier keys add on
 *      top; it must never quietly become the primary action.
 *   4. Right-clicking a row *inside* the selection offers the batch move. The
 *      toolbar button and the drag path already move every picked row; a row menu
 *      that moved only the row under the cursor made the same selection look
 *      broken depending on which control the user reached for.
 *
 * home-side.ts is transpiled into a sandbox because its imports are extensionless
 * (a bundler resolves them, node does not).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const UNGROUPED = '__ungrouped__';

class El {
  children: El[] = [];
  innerHTML = '';
  textContent = '';
  title = '';
  type = '';
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  style: any = { setProperty() {} };
  hidden = false;
  onclick?: (event?: any) => void;
  oncontextmenu?: (event?: any) => void;
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
  querySelector(): El { return new El(); }
  querySelectorAll(): El[] { return []; }
  addEventListener(): void {}
  removeEventListener(): void {}
}

interface RenderOptions {
  items: any[];
  groups?: Record<string, string>;
  order?: string[];
  collapsed?: string[];
  query?: string;
  onRowClick?: (item: any, mods: any, visibleKeys: string[]) => boolean;
  onSelect?: (item: any) => void;
  isRowSelected?: (key: string) => boolean;
  getSelection?: () => string[];
}

/** Render the list once and hand back the list element plus the recorded calls. */
function render(opts: RenderOptions): {
  list: El;
  headerSlot: El;
  selected: any[];
  rowClicks: { key: string; mods: any; visibleKeys: string[] }[];
  contextMenus: any[][];
} {
  const selected: any[] = [];
  const rowClicks: { key: string; mods: any; visibleKeys: string[] }[] = [];
  const contextMenus: any[][] = [];
  const groups = opts.groups ?? {};

  const mocks: Record<string, any> = {
    './connection-sort': {
      sortGroupConnections: (items: any[]) => [...items],
    },
    './group-sort-menu': { showGroupSortMenu: () => {} },
    './i18n': { t: (key: string) => key },
    './icons': { icon: () => '' },
    './app-state': { settings: { language: 'zh' } },
    './home-dashboard-left': {
      collectAllConnections: () => opts.items,
      filterConnections: (items: any[], query: string) =>
        query ? items.filter((item) => item.name.includes(query)) : items,
      escapeHtml: (value: string) => value,
      showConnectionContextMenu: (...args: any[]) => { contextMenus.push(args); },
    },
    './connection-groups': {
      loadGroupMap: () => groups,
      loadGroupOrder: () => opts.order ?? [],
      loadGroupCollapsed: () => new Set(opts.collapsed ?? []),
      toggleGroupCollapsed: () => {},
      // Stub of the real helper: the app's own `__` names are not groups a user
      // can see, so the renderer reads an assignment through it (see
      // connection-groups.ts).
      visibleGroupName: (stored: string | null | undefined) =>
        (stored && !stored.startsWith('__') ? stored : null),
    },
  };

  const code = ts.transpileModule(
    readFileSync(new URL('../src/home-side.ts', import.meta.url), 'utf8'),
    
    // Transpile at the project's target (tsconfig: ES2021). At the ES5 default TS
  // downlevels iterator spreads into a `.length`-based loop, which silently
  // yields nothing for a Set/Map — the harness has to match the real build.
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } },
  ).outputText;

  const exports: any = {};
  vm.runInNewContext(code, {
    exports,
    document: { createElement: () => new El() },
    localStorage: { getItem: () => null, setItem: () => {} },
    require: (specifier: string) => {
      if (!mocks[specifier]) throw new Error(`unexpected import ${specifier}`);
      return mocks[specifier];
    },
  });

  const list = new El();
  const headerSlot = new El();
  exports.renderSidebarList(list, headerSlot, opts.query ?? '', {
    onSelect: (item: any) => { selected.push(item); opts.onSelect?.(item); },
    refresh: () => {},
    getSelectedKey: () => null,
    isRowSelected: opts.isRowSelected,
    getSelection: opts.getSelection,
    onRowClick: opts.onRowClick
      ? (item: any, mods: any, visibleKeys: string[]) => {
        rowClicks.push({ key: item.key, mods, visibleKeys });
        return opts.onRowClick!(item, mods, visibleKeys);
      }
      : undefined,
  });
  return { list, headerSlot, selected, rowClicks, contextMenus };
}

const row = (key: string, name: string) => ({ key, name, type: 'ssh', detail: 'root@host:22', raw: {} });
const hasClass = (el: El, name: string): boolean => el.className.split(' ').includes(name);
/**
 * Exact class match: a plain `includes` would also swallow
 * `.home-side-group-empty`.
 *
 * The lone group's header is hoisted out of the scroll area into the fixed slot
 * above it (that is what keeps the first row crisp under the mask feather), so
 * the visible list is the slot's children followed by the scroll area's.
 */
const visibleChildren = (r: { list: El; headerSlot: El }): El[] => [...r.headerSlot.children, ...r.list.children];
const headers = (r: { list: El; headerSlot: El }): El[] =>
  visibleChildren(r).filter((c) => hasClass(c, 'home-side-group'));
const rows = (r: { list: El; headerSlot: El }): El[] =>
  visibleChildren(r).filter((c) => hasClass(c, 'home-side-row'));

test('an empty named group is rendered, and says it is a drop target', () => {
  const r = render({
    items: [row('ssh:a', 'a'), row('ssh:b', 'b')],
    groups: { 'ssh:a': 'prod' },
    order: ['prod', 'staging'],
  });

  const groups = headers(r).map((h) => h.dataset.group);
  assert.deepEqual(groups, ['prod', 'staging', UNGROUPED], 'the newly created group must be visible');

  const staging = headers(r).find((h) => h.dataset.group === 'staging')!;
  assert.match(staging.innerHTML, /class="hsg-count">0</, 'an empty group still reports its count');

  const hint = r.list.children.find((c) => c.className.includes('home-side-group-empty'));
  assert.ok(hint, 'an empty group must advertise itself as a drop target');
});

test('the ungrouped bucket is always present, so a row can always be dragged out', () => {
  const r = render({
    items: [row('ssh:a', 'a')],
    groups: { 'ssh:a': 'prod' },
    order: ['prod'],
  });
  assert.deepEqual(headers(r).map((h) => h.dataset.group), ['prod', UNGROUPED]);
});

test('every row carries its key and its group for the drag controller', () => {
  const r = render({
    items: [row('ssh:a', 'a'), row('ssh:b', 'b')],
    groups: { 'ssh:a': 'prod' },
    order: ['prod'],
  });
  const rendered = rows(r);
  assert.deepEqual(rendered.map((r) => r.dataset.key), ['ssh:a', 'ssh:b']);
  assert.deepEqual(rendered.map((r) => r.dataset.group), ['prod', UNGROUPED]);
});

test('a plain click still connects; a modified click only selects', () => {
  const r = render({
    items: [row('ssh:a', 'a'), row('ssh:b', 'b')],
    onRowClick: (_item, mods) => !mods.toggle && !mods.range,
  });
  const rendered = rows(r);

  rendered[0].onclick!({ metaKey: false, ctrlKey: false, shiftKey: false });
  assert.equal(r.selected.length, 1, 'an unmodified click must still open the connection');

  rendered[1].onclick!({ metaKey: true, ctrlKey: false, shiftKey: false });
  assert.equal(r.selected.length, 1, 'selecting a row must not open it');

  rendered[1].onclick!({ metaKey: false, ctrlKey: false, shiftKey: true });
  assert.equal(r.selected.length, 1, 'a range click must not open anything');
});

test('the row click reports the on-screen order, so a range cannot span hidden rows', () => {
  const r = render({
    items: [row('ssh:a', 'a'), row('ssh:b', 'b'), row('ssh:c', 'c')],
    groups: { 'ssh:b': 'hidden' },
    order: ['hidden'],
    collapsed: ['hidden'],
    onRowClick: () => false,
  });
  const rendered = rows(r);
  rendered[0].onclick!({ metaKey: true, ctrlKey: false, shiftKey: false });

  assert.equal(r.rowClicks.length, 1);
  assert.deepEqual(
    [...r.rowClicks[0].visibleKeys],
    rendered.map((el) => el.dataset.key),
    'visibleKeys must match the rendered rows exactly',
  );
  assert.ok(![...r.rowClicks[0].visibleKeys].includes('ssh:b'), 'a collapsed group contributes no keys');
});

test('searching narrows the list to groups that matched', () => {
  const r = render({
    items: [row('ssh:a', 'alpha'), row('ssh:b', 'beta')],
    groups: { 'ssh:a': 'prod', 'ssh:b': 'staging' },
    order: ['prod', 'staging'],
    query: 'alpha',
  });
  assert.deepEqual(headers(r).map((h) => h.dataset.group), ['prod']);
  assert.deepEqual(rows(r).map((el) => el.dataset.key), ['ssh:a']);
});

test('with nothing to show the list keeps its empty state', () => {
  const r = render({ items: [] });
  assert.equal(headers(r).length, 0);
  assert.equal(r.list.children.length, 1);
  assert.ok(r.list.children[0].className.includes('home-side-empty'));
});

test('a selected row is marked, and the mark survives a re-render', () => {
  const r = render({
    items: [row('ssh:a', 'a'), row('ssh:b', 'b')],
    isRowSelected: (key) => key === 'ssh:b',
  });
  assert.deepEqual(rows(r).map((el) => el.classList.contains('hsr-picked')), [false, true]);
});

/**
 * The 6th argument of `showConnectionContextMenu` is the batch the "move to
 * group" entries act on. These three cases are the whole rule, and the middle
 * one is the one worth writing down: a right-click on a row *outside* the
 * selection means "this row", so a stale selection must not move instead.
 */
const moveKeysOf = (r: { contextMenus: any[][] }): readonly string[] | undefined => r.contextMenus[0][5];

test('right-clicking a row inside the selection offers the whole batch', () => {
  const r = render({
    items: [row('ssh:a', 'a'), row('ssh:b', 'b'), row('ssh:c', 'c')],
    order: ['prod'],
    getSelection: () => ['ssh:a', 'ssh:b'],
  });
  assert.equal(r.contextMenus.length, 0, 'no menu before anything is right-clicked');

  rows(r)[0].oncontextmenu!({ preventDefault() {} });
  assert.deepEqual(moveKeysOf(r), ['ssh:a', 'ssh:b']);
});

test('right-clicking a row outside the selection acts on that row alone', () => {
  const r = render({
    items: [row('ssh:a', 'a'), row('ssh:b', 'b'), row('ssh:c', 'c')],
    order: ['prod'],
    getSelection: () => ['ssh:a', 'ssh:b'],
  });
  rows(r)[2].oncontextmenu!({ preventDefault() {} });

  assert.equal(
    moveKeysOf(r),
    undefined,
    'a row outside the selection must fall back to the single-row path — handing over the '
    + 'stale selection here is exactly how a batch menu moves rows the user is not pointing at',
  );
});

test('a list with no selection concept keeps moving one row', () => {
  const r = render({ items: [row('ssh:a', 'a')], order: ['prod'] });
  rows(r)[0].oncontextmenu!({ preventDefault() {} });

  assert.equal(moveKeysOf(r), undefined, 'GetSelection is optional; without it the menu must still work');
});

test('a single-row selection is passed through unchanged', () => {
  const r = render({
    items: [row('ssh:a', 'a')],
    order: ['prod'],
    getSelection: () => ['ssh:a'],
  });
  rows(r)[0].oncontextmenu!({ preventDefault() {} });

  assert.deepEqual(moveKeysOf(r), ['ssh:a'], 'the suffix renders `(1)` off this length, so it must be the real list');
});
