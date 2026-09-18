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
const connection = (host: string, name = host, port = 22) => ({ host, name, port });
const sorted = (items: ReturnType<typeof connection>[], mode: any) => sortConnections(items, mode, 'zh-CN', x => x);

test('IPv4 sorting is numeric, reversible and does not mutate saved order', () => {
  const items = ['10.0.0.100', '10.0.0.2', '2.0.0.1', '10.0.0.10'].map(x => connection(x));
  const before = [...items];
  const asc = sorted(items, 'ip-asc');
  assert.deepEqual(asc.map(x => x.host), ['2.0.0.1', '10.0.0.2', '10.0.0.10', '10.0.0.100']);
  assert.deepEqual(sorted(items, 'ip-desc'), [...asc].reverse());
  assert.deepEqual(items, before);
  assert.deepEqual(sorted(items, 'default'), before);
  assert.notEqual(sorted(items, 'default'), items);
});

test('same IP uses port then natural name, exact ties remain stable', () => {
  const items = [connection('10.0.0.1', 'node10'), connection('10.0.0.1', 'node2'),
    connection('10.0.0.1', 'node2'), connection('10.0.0.1', 'node1', 2222)];
  assert.deepEqual(sorted(items, 'ip-asc'), [items[1], items[2], items[0], items[3]]);
  assert.deepEqual(sorted(items, 'ip-desc'), [items[3], items[0], items[1], items[2]]);
});

test('domain and IPv6 sorting uses natural text without network resolution', () => {
  for (const hosts of [['server10.example', 'server2.example', 'server1.example'], ['2001:db8::10', '2001:db8::2', '2001:db8::1']]) {
    assert.deepEqual(sorted(hosts.map(x => connection(x)), 'ip-asc').map(x => x.host), [hosts[2], hosts[1], hosts[0]]);
  }
  const mixed = ['10.0.0.2', 'server2.example', '2001:db8::2', '10.0.0.10'].map(x => connection(x));
  assert.deepEqual(sorted(mixed, 'ip-desc'), sorted(mixed, 'ip-asc').reverse());
});

test('names use locale natural ordering and stable equal names', () => {
  const items = [connection('a', '设备10'), connection('b', '设备2'), connection('c', '设备2')];
  assert.deepEqual(sorted(items, 'name-asc'), [items[1], items[2], items[0]]);
  assert.deepEqual(sorted(items, 'name-desc'), items);
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const english = [connection('a', 'Node10'), connection('b', 'node2')];
  assert.deepEqual(sortConnections(english, 'name-asc', 'en', x => x), [...english].sort((a,b) => collator.compare(a.name,b.name)));
});

test('each group persists independently, invalid storage safely defaults', () => {
  saved.clear();
  for (const value of ['not-json', 'null', '[]', '{"bad":"unknown"}']) {
    saved.set(GROUP_SORT_KEY, value);
    assert.equal(getGroupSort('bad'), 'default');
  }
  saved.clear();
  setGroupSort('production', 'ip-asc'); setGroupSort('testing', 'name-desc'); setGroupSort('__ungrouped__', 'ip-desc');
  // Fresh reads from persisted JSON, with no in-memory preference cache.
  assert.equal(getGroupSort('production'), 'ip-asc'); assert.equal(getGroupSort('testing'), 'name-desc');
  assert.equal(getGroupSort('__ungrouped__'), 'ip-desc');
  assert.equal(getGroupSort('__proto__'), 'default'); assert.equal(getGroupSort('toString'), 'default');
  setGroupSort('__proto__', 'name-asc'); assert.equal(getGroupSort('__proto__'), 'name-asc');
  migrateGroupSort('production', 'renamed'); assert.equal(getGroupSort('production'), 'default');
  assert.equal(getGroupSort('renamed'), 'ip-asc'); migrateGroupSort('renamed'); assert.equal(getGroupSort('renamed'), 'default');
});

test('group CRUD migrates sorting without changing group ordering semantics', () => {
  saved.clear();
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/connection-groups.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, localStorage, require: () => ({ migrateGroupSort }) });
  exports.createGroup('a'); exports.createGroup('b'); exports.setConnectionGroup('ssh:x', 'a');
  setGroupSort('a', 'ip-desc'); exports.renameGroup('a', 'c');
  assert.deepEqual(JSON.parse(JSON.stringify(exports.loadGroupOrder())), ['c', 'b']);
  assert.equal(getGroupSort('c'), 'ip-desc'); assert.equal(exports.getConnectionGroup('ssh:x'), 'c');
  exports.deleteGroup('c'); assert.equal(getGroupSort('c'), 'default');
  assert.equal(exports.getConnectionGroup('ssh:x'), undefined);
});

test('filtering and CRUD retain the selected display order', () => {
  saved.clear(); setGroupSort('a', 'ip-asc');
  const items = [connection('10.0.0.10'), connection('10.0.0.2')];
  items.push(connection('10.0.0.1'));
  items[0] = connection('10.0.0.3');
  const filtered = items.filter(x => x.host !== '10.0.0.1');
  assert.deepEqual(sorted(filtered, getGroupSort('a')).map(x => x.host), ['10.0.0.2', '10.0.0.3']);
  items.splice(1, 1);
  assert.deepEqual(sorted(items, getGroupSort('a')).map(x => x.host), ['10.0.0.1', '10.0.0.3']);
});
