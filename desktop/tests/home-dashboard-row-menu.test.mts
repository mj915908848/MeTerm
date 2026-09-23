/**
 * The row menu's "move to group" entries — what each one acts on.
 *
 * Two rules meet here, and both are easy to undo without noticing:
 *
 *   1. **A batch, not the row under the cursor.** `moveKeys` (the 6th argument)
 *      makes the move entries carry the whole selection. `connection-manager-
 *      groups.test.mts` pins that the list hands the selection over; what that
 *      argument *does* is this file.
 *   2. **A destination is hidden only when the whole batch is already there.**
 *      The entry for the cursor row's own group used to be dropped by comparing
 *      that group with the row's — right while a menu could move one row, and
 *      wrong the moment it can move a selection: with rows picked in A and B and
 *      the cursor on an A row, the B rows could no longer be moved into A, which
 *      is the destination the user was most likely reaching for. It looked like
 *      a missing menu entry rather than a bug, because the destination is the
 *      group the user is *looking at*.
 *
 * `home-dashboard-left.ts` is transpiled into a sandbox (its imports are
 * extensionless), and its `./connection-groups` import is the real module in a
 * nested sandbox — so `getConnectionGroup` is the predicate the app ships, not a
 * re-implementation. That matters for the last case: a row filed under a name the
 * app owns reads as ungrouped, and the menu has to agree with what the list drew.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as connectionSort from '../src/connection-sort.ts';

const SRC = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const ES2021 = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } as const;

// `connection-sort.ts` is imported for real and reads the bare global
// `localStorage`, so the store has to exist in this realm too.
const saved = new Map<string, string>();
const stubStorage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => { saved.set(key, value); },
  removeItem: (key: string) => { saved.delete(key); },
};
Object.defineProperty(globalThis, 'localStorage', { value: stubStorage, configurable: true });

const ORDER_KEY = 'meterm-connection-group-order';
const MAP_KEY = 'meterm-connection-groups';

/** Minimal element: a menu needs `style`, a rect, and its own removal. */
class El {
  children: El[] = [];
  textContent = '';
  innerHTML = '';
  value = '';
  style: Record<string, string> = { left: '', top: '' };
  attrs: Record<string, string> = {};
  onclick?: () => void;
  removed = false;
  private parent: El | null = null;
  private names = new Set<string>();

  get className(): string { return [...this.names].join(' '); }
  set className(value: string) { this.names = new Set(value.split(/\s+/).filter(Boolean)); }
  classList = {
    add: (c: string) => { this.names.add(c); },
    remove: (c: string) => { this.names.delete(c); },
    contains: (c: string) => this.names.has(c),
  };
  appendChild(el: El): El { el.parent = this; this.children.push(el); return el; }
  remove(): void {
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  getBoundingClientRect(): { right: number; bottom: number; width: number; height: number } {
    return { right: 0, bottom: 0, width: 0, height: 0 };
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  focus(): void {}
}

interface MenuOptions {
  /** What `loadGroupOrder()` returns — the groups a user can move into. */
  order: string[];
  /** The raw stored assignment per connection key. */
  groups: Record<string, string>;
  /** Right-clicked connection. */
  item: { key: string };
  /** The group of the right-clicked row, as the caller reads it. */
  currentGroup: string | null;
  /** Selection handed over as the 6th argument; omit for the single-row path. */
  moveKeys?: string[];
}

/** Open the real row menu and return the text of its entries, in order. */
function openMenu(opts: MenuOptions): string[] {
  const groupExports: any = {};
  vm.runInNewContext(ts.transpileModule(SRC('src/connection-groups.ts'), { compilerOptions: ES2021 }).outputText, {
    exports: groupExports,
    localStorage: stubStorage,
    require: (specifier: string) => {
      if (specifier === './connection-sort') return connectionSort;
      throw new Error(`connection-groups: unexpected import ${specifier}`);
    },
  });

  saved.clear();
  saved.set(ORDER_KEY, JSON.stringify(opts.order));
  saved.set(MAP_KEY, JSON.stringify(opts.groups));

  const body = new El();
  const noop = (): void => {};
  const mocks: Record<string, any> = {
    './app-state': { settings: { language: 'zh' } },
    './i18n': { t: (key: string) => key },
    './icons': { icon: () => '' },
    './notify': { showToast: noop },
    './overlay-scrollbar': { createOverlayScrollbar: noop },
    './development-credential-recovery-ui': { appendSshConnectionMenuItems: noop },
    './home-dashboard-card-order': { loadCardOrder: () => [], saveCardOrder: noop },
    './home-card-width': { clearCardWidth: noop, dragCardWidth: noop, loadCardWidths: () => ({}), setCardWidth: noop },
    './connection-sort': connectionSort,
    './connection-groups': groupExports,
    './ssh': {
      loadSavedConnections: () => [], loadRecentConnections: () => [], removeRecentConnection: noop,
      showSSHModal: noop, removeConnection: noop, getSSHConnectHandler: () => null,
    },
    './remote': {
      loadSavedRemoteConnections: () => [], loadRecentRemoteConnections: () => [], removeRecentRemoteConnection: noop,
      showRemoteEditDialog: noop, showRemoteCardSessionPopup: noop, removeRemoteConnection: noop,
    },
    './jumpserver-api': { loadJumpServerConfigs: () => [], removeJumpServerConfig: noop },
  };

  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(SRC('src/home-dashboard-left.ts'), { compilerOptions: ES2021 }).outputText, {
    exports,
    document: {
      createElement: () => new El(),
      body,
      // `removeContextMenu()` is the only reader, and there is nothing to remove.
      querySelector: () => null,
      addEventListener: noop,
      removeEventListener: noop,
    },
    window: { innerWidth: 1280, innerHeight: 900 },
    setTimeout: noop,
    require: (specifier: string) => {
      if (!mocks[specifier]) throw new Error(`home-dashboard-left: unexpected import ${specifier}`);
      return mocks[specifier];
    },
  });

  const item = { type: 'ssh', key: opts.item.key, name: opts.item.key, detail: '', raw: {} };
  // `onEdit` is supplied so the menu takes the plain-edit branch: the SSH extras
  // are a different module with a different contract.
  exports.showConnectionContextMenu(
    { clientX: 12, clientY: 12 },
    item,
    opts.currentGroup,
    () => {},
    () => {},
    opts.moveKeys,
  );

  const menu = body.children[body.children.length - 1];
  assert.ok(menu, 'the menu must be attached to the body');
  return menu.children
    .filter((child) => child.className.split(' ').includes('home-card-menu-item'))
    .map((child) => child.textContent);
}

/** Only the "move to" entries, which are the ones with the arrow prefix. */
const targets = (entries: string[]): string[] => entries.filter((e) => e.startsWith('→ '));

test("a batch spanning two groups can still be moved into the cursor row's own group", () => {
  const entries = openMenu({
    order: ['prod', 'staging'],
    groups: { 'ssh:a': 'prod', 'ssh:b': 'staging', 'ssh:c': 'staging' },
    item: { key: 'ssh:a' },
    currentGroup: 'prod',
    moveKeys: ['ssh:a', 'ssh:b', 'ssh:c'],
  });

  assert.deepEqual(
    targets(entries),
    ['→ prod (3)', '→ staging (3)', '→ homeGroupUngrouped (3)'],
    'the cursor row is in `prod`, but `ssh:b` and `ssh:c` are not — so `prod` is the one destination '
    + 'that has to stay on the menu, and dropping it was the whole bug',
  );
});

test('a destination the whole batch already sits in is not offered', () => {
  const entries = openMenu({
    order: ['prod', 'staging'],
    groups: { 'ssh:a': 'prod', 'ssh:b': 'prod' },
    item: { key: 'ssh:a' },
    currentGroup: 'prod',
    moveKeys: ['ssh:a', 'ssh:b'],
  });

  assert.deepEqual(
    targets(entries),
    ['→ staging (2)', '→ homeGroupUngrouped (2)'],
    'the per-batch rule still suppresses a no-op destination — otherwise every menu grows an entry '
    + 'that does nothing',
  );
});

test('a single row keeps the menu it always had', () => {
  const entries = openMenu({
    order: ['prod', 'staging'],
    groups: { 'ssh:a': 'prod' },
    item: { key: 'ssh:a' },
    currentGroup: 'prod',
  });

  assert.deepEqual(
    targets(entries),
    ['→ staging', '→ homeGroupUngrouped'],
    "a row's own group and the ungrouped bucket are both no-ops for one row in `prod`",
  );
});

test('a batch that is already ungrouped is not offered the ungrouped bucket', () => {
  const entries = openMenu({
    order: ['prod'],
    groups: {},
    item: { key: 'ssh:a' },
    currentGroup: null,
    moveKeys: ['ssh:a', 'ssh:b'],
  });

  assert.deepEqual(targets(entries), ['→ prod (2)'], 'moving ungrouped rows to "ungrouped" changes nothing');
});

test('a row left under a reserved name is read as ungrouped, so the menu agrees with the list', () => {
  const entries = openMenu({
    order: ['prod'],
    // What a store written before the refusal existed holds. `getConnectionGroup`
    // normalizes it, which is exactly what `renderGroupsSection` renders — the
    // menu has to answer the same way or it offers a no-op.
    groups: { 'ssh:a': '__type:ssh' },
    item: { key: 'ssh:a' },
    currentGroup: null,
  });

  assert.deepEqual(
    targets(entries),
    ['→ prod'],
    'the row is drawn under the ungrouped bucket, so "ungrouped" is not a destination for it',
  );
});
