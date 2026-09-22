/**
 * Multi-select rules for the connection list.
 *
 * The property that must not drift: an unmodified click still opens the
 * connection. Everything modifier-driven is selection only. A drag that started
 * on a picked row carries the whole selection, and a "N selected" count is only
 * allowed to count rows that still exist.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { keysToDrag, pruneSelection, resolveRowClick } from '../src/connection-selection.ts';

const KEYS = ['ssh:a', 'ssh:b', 'ssh:c', 'ssh:d'];
const none = { selection: [], anchor: null };
const plain = { toggle: false, range: false };
const toggle = { toggle: true, range: false };
const range = { toggle: false, range: true };

test('a plain click still opens the connection and drops the selection', () => {
  const outcome = resolveRowClick(KEYS, { selection: ['ssh:b', 'ssh:c'], anchor: 'ssh:b' }, 'ssh:a', plain);
  assert.equal(outcome.connect, true, 'the primary action must not change');
  assert.deepEqual(outcome.selection, [], 'a stale selection must not survive into the next drag');
  assert.equal(outcome.anchor, 'ssh:a', 'the range anchor follows the click');
});

test('the toggle modifier adds and removes one row, and never connects', () => {
  const added = resolveRowClick(KEYS, none, 'ssh:b', toggle);
  assert.equal(added.connect, false, 'selecting several rows must not open one of them');
  assert.deepEqual(added.selection, ['ssh:b']);

  const removed = resolveRowClick(KEYS, { selection: ['ssh:b'], anchor: 'ssh:b' }, 'ssh:b', toggle);
  assert.deepEqual(removed.selection, [], 'clicking a picked row again unpicks it');
});

test('shift ranges over the rows on screen, in either direction', () => {
  const down = resolveRowClick(KEYS, { selection: ['ssh:b'], anchor: 'ssh:b' }, 'ssh:d', range);
  assert.deepEqual(down.selection, ['ssh:b', 'ssh:c', 'ssh:d']);
  assert.equal(down.anchor, 'ssh:b', 'the anchor stays put so the range can be resized');

  const up = resolveRowClick(KEYS, { selection: ['ssh:c'], anchor: 'ssh:c' }, 'ssh:a', range);
  assert.deepEqual(up.selection, ['ssh:a', 'ssh:b', 'ssh:c']);
});

test('a range never spans rows that are not rendered', () => {
  // A collapsed group contributes no keys, so a range across it cannot silently
  // pick up connections the user cannot see.
  const visible = ['ssh:a', 'ssh:d'];
  const outcome = resolveRowClick(visible, { selection: ['ssh:a'], anchor: 'ssh:a' }, 'ssh:d', range);
  assert.deepEqual(outcome.selection, ['ssh:a', 'ssh:d']);
  assert.ok(!outcome.selection.includes('ssh:b'), 'hidden rows must stay out of the range');
});

test('a shift-click whose anchor is gone falls back to a single selection', () => {
  const outcome = resolveRowClick(KEYS, { selection: ['ssh:gone'], anchor: 'ssh:gone' }, 'ssh:c', range);
  assert.deepEqual(outcome.selection, ['ssh:c']);
  assert.equal(outcome.connect, false, 'the shift-click must still not open anything');
});

test('a drag carries the selection only when it starts inside it', () => {
  assert.deepEqual(keysToDrag('ssh:b', ['ssh:b', 'ssh:c']), ['ssh:b', 'ssh:c']);
  assert.deepEqual(
    keysToDrag('ssh:a', ['ssh:b', 'ssh:c']),
    ['ssh:a'],
    'grabbing an unpicked row moves that row alone, never a stale selection',
  );
  assert.deepEqual(keysToDrag('ssh:a', []), ['ssh:a']);
});

test('stale keys are dropped so the selected count cannot lie', () => {
  assert.deepEqual(pruneSelection(['ssh:a', 'ssh:deleted', 'ssh:b'], ['ssh:a', 'ssh:b']), ['ssh:a', 'ssh:b']);
  assert.deepEqual(pruneSelection(['ssh:a'], []), []);
  assert.deepEqual(pruneSelection([], ['ssh:a']), []);
});
