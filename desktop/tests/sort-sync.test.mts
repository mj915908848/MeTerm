import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  connectionSortFields,
  setGroupSort,
  sortGroupConnections,
} from '../src/connection-sort.ts';

/**
 * The connections drawer and the home page both list a group's rows, and the two
 * lists have to agree on the order: switching a group to "name descending" in one
 * has to reorder the other. Both render through home-side.ts, so the wiring
 * checks below are that both use that renderer and that it sorts.
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

const homeManager = read('../src/home-connection-manager.ts');
const drawer = read('../src/connections-drawer.ts');
const sideList = read('../src/home-side.ts');
const sortSource = read('../src/connection-sort.ts');

/** Read from the source so the test cannot disagree with the app's own name. */
const UNGROUPED_BUCKET = /const UNGROUPED_GROUP = '([^']+)'/.exec(sortSource)?.[1] ?? '';

const row = (name: string, addedAt?: number) => ({ name, raw: { host: '10.0.0.1', port: 22, addedAt } });

test('a group is ordered by the mode saved for that group', () => {
  const items = [row('b', 300), row('c', 100), row('a', 200)];

  setGroupSort('prod', 'name-desc');
  assert.deepEqual(sortGroupConnections(items, 'prod', 'zh-CN').map(x => x.name), ['c', 'b', 'a']);

  setGroupSort('prod', 'added-asc');
  assert.deepEqual(sortGroupConnections(items, 'prod', 'zh-CN').map(x => x.name), ['c', 'a', 'b']);
});

test('null addresses the ungrouped bucket the list actually keys', () => {
  const items = [row('b'), row('a')];

  setGroupSort(UNGROUPED_BUCKET, 'name-asc');
  assert.deepEqual(
    sortGroupConnections(items, null, 'zh-CN').map(x => x.name),
    ['a', 'b'],
    'the home page reaches the ungrouped bucket through null, not a literal',
  );
});

test('SSH and JumpServer configs both carry their date added in raw.addedAt', () => {
  assert.deepEqual(
    connectionSortFields({ name: 'js', raw: { sshHost: '10.0.0.9', sshPort: 2222, addedAt: 5 } }),
    { name: 'js', addedAt: 5 },
  );
  assert.deepEqual(connectionSortFields({ name: 'old', raw: { host: '10.0.0.1' } }), { name: 'old', addedAt: undefined });
  assert.deepEqual(
    connectionSortFields({ name: 'broken', raw: undefined }),
    { name: 'broken', addedAt: undefined },
    'a row with no raw config must not throw in the middle of a sort',
  );
});

test('both surfaces order group rows through the shared sorter', () => {
  assert.match(sideList, /sortGroupConnections\(/, 'the shared list renderer does not order its rows');
  for (const [label, source] of [['home page', homeManager], ['connections drawer', drawer]] as const) {
    assert.match(source, /renderSidebarList\(/, `${label} must render through the shared list`);
  }
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
