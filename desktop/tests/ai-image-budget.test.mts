import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  ALLOWED_IMAGE_MIMES,
  IMAGE_BUDGET_BYTES,
  MAX_IMAGE_RAW_BYTES,
  MAX_IMAGES,
  MAX_REQUEST_BODY_BYTES,
  MIN_LONGEST_EDGE,
  REQUEST_HEADROOM_BYTES,
  base64Bytes,
  base64DecodedBytes,
  downscaleLadder,
  evaluateAdmission,
  formatBytes,
  isShrinkable,
  planShrink,
  sumEncodedBytes,
} from '../src/ai-image-budget.ts';

const MB = 1024 * 1024;

/** Admission request with sensible defaults, so each test states only what it means. */
const request = (over: Partial<Parameters<typeof evaluateAdmission>[0]> = {}) => ({
  queuedCount: 0,
  queuedEncodedBytes: 0,
  mediaType: 'image/png',
  rawBytes: 200 * 1024,
  encodedBytes: base64Bytes(200 * 1024),
  ...over,
});

test('base64 expansion is the 4/3 ratio, rounded up to the next 4-byte group', () => {
  assert.equal(base64Bytes(0), 0);
  assert.equal(base64Bytes(1), 4);
  assert.equal(base64Bytes(3), 4);
  assert.equal(base64Bytes(4), 8);
  assert.equal(base64Bytes(6), 8);
  // A 5 MB image becomes ~6.67 MB on the wire — the whole reason the old
  // raw-byte accounting was wrong.
  assert.equal(base64Bytes(5 * MB), 6_990_508);
});

test('encoded size can be recovered from a base64 string without decoding it', () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 64, 1000, 200 * 1024]) {
    const encoded = Buffer.alloc(n, 0x41).toString('base64');
    assert.equal(base64DecodedBytes(encoded), n, `raw ${n}`);
    assert.equal(encoded.length, base64Bytes(n), `encoded ${n}`);
  }
  assert.equal(base64DecodedBytes(''), 0);
});

test('a turn accumulates the encoded size of every queued image', () => {
  assert.equal(sumEncodedBytes([]), 0);
  assert.equal(
    sumEncodedBytes([{ data: 'x'.repeat(10) }, { data: 'y'.repeat(32) }]),
    42,
  );
});

test('an ordinary screenshot joins an empty turn', () => {
  const verdict = evaluateAdmission(request());
  assert.deepEqual(verdict, { admitted: true });
});

test('a fifth image is refused — the cap is per turn, not per drop', () => {
  const verdict = evaluateAdmission(request({ queuedCount: MAX_IMAGES }));
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.admitted === false && verdict.reason, 'too-many');
  assert.equal(verdict.admitted === false && verdict.canShrink, false);
});

test('unsupported formats are refused before anything is encoded', () => {
  const verdict = evaluateAdmission(request({ mediaType: 'image/svg+xml' }));
  assert.equal(verdict.admitted === false && verdict.reason, 'unsupported-type');
  assert.equal(verdict.admitted === false && verdict.canShrink, false);
  assert.deepEqual(ALLOWED_IMAGE_MIMES, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
});

test('an oversized image is shrinkable, except when re-encoding would lose it', () => {
  const tooBig = MAX_IMAGE_RAW_BYTES + 1;

  for (const mediaType of ['image/png', 'image/jpeg', 'image/webp']) {
    const verdict = evaluateAdmission(request({ mediaType, rawBytes: tooBig }));
    assert.equal(verdict.admitted === false && verdict.reason, 'image-too-large', mediaType);
    assert.equal(verdict.admitted === false && verdict.canShrink, true, mediaType);
  }

  // Rasterising a GIF drops the animation, which is the only reason to send one.
  const gif = evaluateAdmission(request({ mediaType: 'image/gif', rawBytes: tooBig }));
  assert.equal(gif.admitted === false && gif.canShrink, false);
  assert.equal(isShrinkable('image/gif'), false);
  assert.equal(isShrinkable('image/png'), true);
});

test('four 5 MB images can no longer be sent — the old allowance was unreachable', () => {
  const perImageRaw = 5 * MB;
  const perImageEncoded = base64Bytes(perImageRaw);
  // The previous limit (4 x 5 MB of raw bytes) worked out to ~26.7 MB once
  // encoded, against a 16 MB request-body cap. It could never have been sent.
  assert.ok(perImageEncoded * MAX_IMAGES > MAX_REQUEST_BODY_BYTES);

  let queuedEncodedBytes = 0;
  let queuedCount = 0;
  const admitted: number[] = [];
  for (let i = 0; i < MAX_IMAGES; i++) {
    const verdict = evaluateAdmission(
      request({ queuedCount, queuedEncodedBytes, rawBytes: perImageRaw, encodedBytes: perImageEncoded }),
    );
    if (verdict.admitted) {
      admitted.push(i);
      queuedCount++;
      queuedEncodedBytes += perImageEncoded;
    }
  }
  assert.ok(
    admitted.length < MAX_IMAGES,
    'at least one of four full-size images must be refused',
  );
  assert.ok(queuedEncodedBytes <= IMAGE_BUDGET_BYTES);
});

test('the running total, not just the single image, is what gets checked', () => {
  const each = base64Bytes(4 * MB);
  const verdict = evaluateAdmission(request({
    queuedCount: 2,
    queuedEncodedBytes: each * 3,
    rawBytes: 4 * MB,
    encodedBytes: each,
  }));
  assert.equal(verdict.admitted === false && verdict.reason, 'turn-too-large');
  assert.equal(verdict.admitted === false && verdict.canShrink, true);
});

test('head-room is reserved so a full-size payload does not collide with the prompt', () => {
  assert.equal(IMAGE_BUDGET_BYTES, MAX_REQUEST_BODY_BYTES - REQUEST_HEADROOM_BYTES);
  assert.ok(IMAGE_BUDGET_BYTES > 0);
  assert.ok(IMAGE_BUDGET_BYTES < MAX_REQUEST_BODY_BYTES);
});

test('the downscale ladder shrinks, stays legible, and never repeats an edge', () => {
  const ladder = downscaleLadder(3000);
  assert.deepEqual(ladder, [2250, 1800, 1500, 1200, 1024]);
  assert.deepEqual([...ladder].sort((a, b) => b - a), ladder, 'largest first');
  assert.equal(new Set(ladder).size, ladder.length, 'no duplicates');
  for (const edge of ladder) assert.ok(edge < 3000 && edge >= MIN_LONGEST_EDGE);
});

test('the ladder stops rather than scaling below the legibility floor', () => {
  // Already at the floor: nothing worth attempting.
  assert.deepEqual(downscaleLadder(MIN_LONGEST_EDGE), []);
  assert.deepEqual(downscaleLadder(MIN_LONGEST_EDGE - 1), []);
  assert.deepEqual(downscaleLadder(0), []);

  // Just above it: the floor itself is the only candidate.
  assert.deepEqual(downscaleLadder(1100), [MIN_LONGEST_EDGE]);

  // A short-but-large image still only offers sizes below its own.
  for (const edge of [1025, 1600, 4000, 5120]) {
    for (const target of downscaleLadder(edge)) {
      assert.ok(target < edge, `${target} must be smaller than ${edge}`);
      assert.ok(target >= MIN_LONGEST_EDGE, `${target} must stay legible`);
    }
  }
});

test('the shrink target is whatever the rest of the turn left in the budget', () => {
  const plan = planShrink({ longestEdge: 3000, otherEncodedBytes: 2 * MB });
  assert.equal(plan.targetEncodedBytes, IMAGE_BUDGET_BYTES - 2 * MB);
  assert.deepEqual(plan.edges, downscaleLadder(3000));

  // Never negative, even if the other images already blew the budget.
  const over = planShrink({ longestEdge: 3000, otherEncodedBytes: IMAGE_BUDGET_BYTES + MB });
  assert.equal(over.targetEncodedBytes, 0);
});

test('byte counts are rendered the way the toast body needs them', () => {
  assert.equal(formatBytes(5 * MB), '5.0 MB');
  assert.equal(formatBytes(6_990_508), '6.7 MB');
  assert.equal(formatBytes(20 * MB), '20 MB');
  assert.equal(formatBytes(0), '0 MB');
});

test('the frontend budget tracks the Rust request-body limit', () => {
  const rust = readFileSync(
    new URL('../src-tauri/src/commands/ai.rs', import.meta.url),
    'utf8',
  );
  const match = rust.match(
    /MAX_REQUEST_BODY_BYTES:\s*usize\s*=\s*([0-9]+)\s*\*\s*1024\s*\*\s*1024/,
  );
  assert.ok(match, 'MAX_REQUEST_BODY_BYTES not found in commands/ai.rs — did it move?');
  assert.equal(
    MAX_REQUEST_BODY_BYTES,
    Number(match[1]) * 1024 * 1024,
    'ai-image-budget.ts and commands/ai.rs disagree about the body limit',
  );
});
