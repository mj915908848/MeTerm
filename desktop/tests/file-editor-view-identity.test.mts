import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyEditorViewContact,
  isValidEditorNonce,
} from '../src/file-editor-events.ts';

/**
 * The editor window's tabs are owned by the window that opened them, so that
 * window has to notice when the editor's view is rebuilt — otherwise it keeps
 * believing tabs exist that are gone, skips the content read for those files and
 * leaves the editor stuck on "Loading…".
 *
 * `classifyEditorViewContact` is the whole decision. Its two jobs that matter
 * for safety are telling "no information" apart from "a different view", and
 * never calling anything `recreated` on evidence it cannot trust: the caller
 * reacts to that answer by discarding its record of every open tab.
 */

const VIEW_A = '3f2a1b4c-5d6e-4f70-9a8b-1c2d3e4f5a6b';
const VIEW_B = '0a1b2c3d-4e5f-4789-ab01-23456789cdef';

test('the fixtures are ids the validator accepts', () => {
  assert.ok(isValidEditorNonce(VIEW_A));
  assert.ok(isValidEditorNonce(VIEW_B));
});

// ── ignore: no usable evidence ──

test('a missing view id is ignored rather than read as a new view', () => {
  // An older editor build answers pings without a viewId. Treating that as
  // "recreated" would wipe the open-tab record on every single handshake.
  assert.equal(classifyEditorViewContact(VIEW_A, undefined), 'ignore');
  assert.equal(classifyEditorViewContact(null, undefined), 'ignore');
});

test('a malformed view id is ignored', () => {
  for (const bad of ['', 'not-a-uuid', 42, null, {}, VIEW_A.slice(0, -1)]) {
    assert.equal(
      classifyEditorViewContact(VIEW_A, bad),
      'ignore',
      `expected ${JSON.stringify(bad)} to be ignored`,
    );
  }
});

test('a malformed id is ignored even when nothing was known yet', () => {
  // Otherwise a garbage value would be recorded as the baseline and the next
  // genuine contact would look like a change.
  assert.equal(classifyEditorViewContact(null, 'nonsense'), 'ignore');
});

// ── known: same view, or first contact ──

test('the first valid contact is simply learned, not treated as a rebuild', () => {
  // Nothing is open yet at that point, so discarding state would be pointless —
  // and calling it a rebuild would also reset the caller's handshake bookkeeping.
  assert.equal(classifyEditorViewContact(null, VIEW_A), 'known');
});

test('the same view answering again stays known', () => {
  assert.equal(classifyEditorViewContact(VIEW_A, VIEW_A), 'known');
});

// ── recreated: the view was rebuilt ──

test('a different id means the view was rebuilt', () => {
  assert.equal(classifyEditorViewContact(VIEW_A, VIEW_B), 'recreated');
  assert.equal(classifyEditorViewContact(VIEW_B, VIEW_A), 'recreated');
});

test('a rebuilt view is still reported when the id only differs in case-insensitively', () => {
  // The validator is case-insensitive for hex; the comparison must not be, or a
  // genuinely different id could be mistaken for the same one.
  const upper = VIEW_A.toUpperCase();
  assert.ok(isValidEditorNonce(upper), 'uppercase hex must pass validation');
  assert.equal(classifyEditorViewContact(VIEW_A, upper), 'recreated');
});

// ── Regression shape ──

test('the stuck-on-Loading sequence resolves to a rebuild', () => {
  // Handshake 1: editor starts, nothing known yet.
  assert.equal(classifyEditorViewContact(null, VIEW_A), 'known');
  // View rebuilt; handshake 2 arrives from the new page load.
  assert.equal(classifyEditorViewContact(VIEW_A, VIEW_B), 'recreated');
  // Caller resets, records the new id, and later handshakes are stable.
  assert.equal(classifyEditorViewContact(VIEW_B, VIEW_B), 'known');
});