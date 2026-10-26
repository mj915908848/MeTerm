import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { GROUP_SORT_KEY, getGroupSort, setGroupSort, migrateGroupSort, sortConnections } from '../src/connection-sort.ts';

const saved = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => saved.set(key, value),
}, configurable: true });
const connection = (name: string, addedAt?: number) => ({ name, addedAt });
const sorted = (items: ReturnType<typeof connection>[], mode: any) => sortConnections(items, mode, 'zh-CN', x => x);

test('date added sorts by save time, reversible, and does not mutate saved order', () => {
  const items = [connection('c', 300), connection('a', 100), connection('b', 200)];
  const before = [...items];
  const asc = sorted(items, 'added-asc');
  assert.deepEqual(asc.map(x => x.name), ['a', 'b', 'c']);
  assert.deepEqual(sorted(items, 'added-desc'), [...asc].reverse());
  assert.deepEqual(items, before);
  assert.notEqual(sorted(items, 'added-asc'), items);
});

test('entries without a date count as oldest and keep their saved order', () => {
  const items = [connection('new', 500), connection('legacy1'), connection('legacy2'), connection('mid', 100)];
  assert.deepEqual(sorted(items, 'added-asc').map(x => x.name), ['legacy1', 'legacy2', 'mid', 'new']);
  assert.deepEqual(sorted(items, 'added-desc').map(x => x.name), ['new', 'mid', 'legacy2', 'legacy1']);
});

test('names use locale natural ordering and equal names flip with the direction', () => {
  const items = [connection('设备10'), connection('设备2'), connection('设备2')];
  assert.deepEqual(sorted(items, 'name-asc'), [items[1], items[2], items[0]]);
  assert.deepEqual(sorted(items, 'name-desc'), [items[0], items[2], items[1]]);
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const english = [connection('Node10'), connection('node2')];
  assert.deepEqual(sortConnections(english, 'name-asc', 'en', x => x), [...english].sort((a,b) => collator.compare(a.name,b.name)));
});

test('each group persists independently, invalid storage safely defaults', () => {
  saved.clear();
  // Modes from older builds (default / IP) fall back to date added, oldest first.
  for (const value of ['not-json', 'null', '[]', '{"bad":"unknown"}', '{"bad":"default"}', '{"bad":"ip-asc"}']) {
    saved.set(GROUP_SORT_KEY, value);
    assert.equal(getGroupSort('bad'), 'added-asc');
  }
  saved.clear();
  setGroupSort('production', 'added-desc'); setGroupSort('testing', 'name-desc'); setGroupSort('__ungrouped__', 'name-asc');
  // Fresh reads from persisted JSON, with no in-memory preference cache.
  assert.equal(getGroupSort('production'), 'added-desc'); assert.equal(getGroupSort('testing'), 'name-desc');
  assert.equal(getGroupSort('__ungrouped__'), 'name-asc');
  assert.equal(getGroupSort('__proto__'), 'added-asc'); assert.equal(getGroupSort('toString'), 'added-asc');
  setGroupSort('__proto__', 'name-asc'); assert.equal(getGroupSort('__proto__'), 'name-asc');
  migrateGroupSort('production', 'renamed'); assert.equal(getGroupSort('production'), 'added-asc');
  assert.equal(getGroupSort('renamed'), 'added-desc'); migrateGroupSort('renamed'); assert.equal(getGroupSort('renamed'), 'added-asc');
});

test('group CRUD migrates sorting without changing group ordering semantics', () => {
  saved.clear();
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/connection-groups.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, localStorage, require: () => ({ migrateGroupSort }) });
  exports.createGroup('a'); exports.createGroup('b'); exports.setConnectionGroup('ssh:x', 'a');
  setGroupSort('a', 'name-asc'); exports.renameGroup('a', 'c');
  assert.deepEqual(JSON.parse(JSON.stringify(exports.loadGroupOrder())), ['c', 'b']);
  assert.equal(getGroupSort('c'), 'name-asc'); assert.equal(exports.getConnectionGroup('ssh:x'), 'c');
  exports.deleteGroup('c'); assert.equal(getGroupSort('c'), 'added-asc');
  assert.equal(exports.getConnectionGroup('ssh:x'), undefined);
});

test('filtering and CRUD retain the selected display order', () => {
  saved.clear(); setGroupSort('a', 'added-desc');
  const items = [connection('x', 10), connection('y', 20)];
  items.push(connection('z', 30));
  const filtered = items.filter(x => x.name !== 'y');
  assert.deepEqual(sorted(filtered, getGroupSort('a')).map(x => x.name), ['z', 'x']);
  items.splice(0, 1);
  assert.deepEqual(sorted(items, getGroupSort('a')).map(x => x.name), ['z', 'y']);
});
