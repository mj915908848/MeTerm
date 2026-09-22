import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  connectionAddress,
  setGroupSort,
  sortGroupConnections,
} from '../src/connection-sort.ts';

/**
 * The connection window and the home page both list a group's rows, and the two
 * lists have to agree on the order: switching a group to "IP ascending" in one
 * has to reorder the other.
 *
 * That only holds while both go through `sortGroupConnections()`. A surface that
 * sorts on its own — or not at all — silently falls back to insertion order,
 * which reads as "the sort I picked over there did nothing here". The behaviour
 * is covered first, then the wiring of both surfaces.
 */

const saved = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => saved.set(key, value),
}, configurable: true });

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8');

const homeCards = read('../src/home-dashboard-left.ts');
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

test('both surfaces order group rows through the shared sorter', () => {
  const surfaces = [['home page', homeCards], ['connection window', sideList]] as const;

  for (const [label, source] of surfaces) {
    assert.match(source, /sortGroupConnections\(/, `${label} does not order its rows`);
  }
});

test('the home page sends its per-type cards to the ungrouped bucket', () => {
  const ungroupedCalls = homeCards.match(/sortGroupConnections\([^\n]*null, settings\.language\)/g) ?? [];

  assert.equal(
    ungroupedCalls.length,
    3,
    'the ssh / remote / jumpserver cards each need the ungrouped mode',
  );
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
