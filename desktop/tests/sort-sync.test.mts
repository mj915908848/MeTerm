import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  connectionAddress,
  setGroupSort,
  sortGroupConnections,
} from '../src/connection-sort.ts';

/**
 * The connections drawer lists a group's rows in the group's saved sort mode
 * (picked from the header's right-click menu). It renders through home-side.ts,
 * which must order rows with `sortGroupConnections()`: a list that sorts on its
 * own — or not at all — silently falls back to insertion order, which reads as
 * "the sort I picked did nothing". (The home page is a table sorted by column
 * headers, so per-group modes do not apply there.) The behaviour is covered
 * first, then the wiring.
 */

const saved = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => saved.set(key, value),
}, configurable: true });

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8');

const drawer = read('../src/connections-drawer.ts');
const sideList = read('../src/home-side.ts');
const sortSource = read('../src/connection-sort.ts');

/** Read from the source so the test cannot disagree with the app's own name. */
const UNGROUPED_BUCKET = /const UNGROUPED_GROUP = '([^']+)'/.exec(sortSource)?.[1] ?? '';

const row = (host: string, name = host) => ({ name, raw: { host, port: 22 } });

test('a group is ordered by the mode saved for that group', () => {
  const items = [row('10.0.0.10'), row('10.0.0.2'), row('2.0.0.1')];

  setGroupSort('prod', 'ip-asc');
  assert.deepEqual(
    sortGroupConnections(items, 'prod', 'zh-CN').map(x => x.name),
    ['2.0.0.1', '10.0.0.2', '10.0.0.10'],
  );

  setGroupSort('prod', 'default');
  assert.deepEqual(
    sortGroupConnections(items, 'prod', 'zh-CN'),
    items,
    'default has to keep the saved order',
  );
});

test('null addresses the ungrouped bucket the list actually keys', () => {
  const items = [row('10.0.0.1', 'b'), row('10.0.0.2', 'a')];

  setGroupSort(UNGROUPED_BUCKET, 'name-asc');
  assert.deepEqual(
    sortGroupConnections(items, null, 'zh-CN').map(x => x.name),
    ['a', 'b'],
    'the home page reaches the ungrouped bucket through null, not a literal',
  );
});

test('JumpServer configs are addressed by sshHost/sshPort', () => {
  assert.deepEqual(
    connectionAddress({ name: 'js', raw: { sshHost: '10.0.0.9', sshPort: 2222 } }),
    { name: 'js', host: '10.0.0.9', port: 2222 },
  );
  assert.deepEqual(
    connectionAddress({ name: 'ssh', raw: { host: '10.0.0.1', port: 22 } }),
    { name: 'ssh', host: '10.0.0.1', port: 22 },
  );
  assert.deepEqual(
    connectionAddress({ name: 'broken', raw: undefined }),
    { name: 'broken', host: '', port: 0 },
    'a row with no raw config must not throw in the middle of a sort',
  );
});

test('the drawer orders group rows through the shared sorter', () => {
  assert.match(sideList, /sortGroupConnections\(/, 'the shared list renderer does not order its rows');
  assert.match(drawer, /renderSidebarList\(/, 'the connections drawer must render through the shared list');
});

test('the ungrouped bucket is spelled the same in both modules', () => {
  const inList = sideList.match(/const UNGROUPED = '([^']+)'/);

  assert.ok(UNGROUPED_BUCKET, 'connection-sort.ts no longer names the ungrouped sort scope');
  assert.ok(inList, 'home-side.ts no longer names the ungrouped bucket');
  assert.equal(
    inList[1],
    UNGROUPED_BUCKET,
    'the bucket the list renders and the scope the sorter reads have drifted apart',
  );
});
