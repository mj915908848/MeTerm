import test from 'node:test';
import assert from 'node:assert/strict';
import {
  feedThumbnail,
  flushThumbnail,
  thumbnailVersion,
  discardThumbnailFeed,
} from '../src/terminal-thumbnail-feed.ts';

function fakeTerminal() {
  const writes: Uint8Array[] = [];
  const mt: any = {
    ended: false,
    thumbnailTerminal: { write: (data: Uint8Array) => writes.push(data) },
  };
  return { mt, writes };
}

test('output is batched into one thumbnail write and bumps the version', () => {
  const { mt, writes } = fakeTerminal();
  const buf = new Uint8Array([1, 2]);
  feedThumbnail(mt, buf);
  buf[0] = 9; // caller reuses its buffer
  feedThumbnail(mt, new Uint8Array([3]));
  assert.equal(writes.length, 0);
  const before = thumbnailVersion(mt);
  flushThumbnail(mt);
  assert.deepEqual(writes.map((w) => Array.from(w)), [[1, 2, 3]]);
  assert.equal(thumbnailVersion(mt), before + 1);
  flushThumbnail(mt);
  assert.equal(writes.length, 1, 'an empty flush writes nothing');
  assert.equal(thumbnailVersion(mt), before + 1, 'and does not count as a change');
});

test('discard drops pending output', () => {
  const { mt, writes } = fakeTerminal();
  feedThumbnail(mt, new Uint8Array([1]));
  discardThumbnailFeed(mt);
  flushThumbnail(mt);
  assert.equal(writes.length, 0);
});

test('terminals without a thumbnail are ignored', () => {
  const mt: any = { ended: false, thumbnailTerminal: null };
  feedThumbnail(mt, new Uint8Array([1]));
  flushThumbnail(mt);
  assert.equal(thumbnailVersion(mt), 0);
});
