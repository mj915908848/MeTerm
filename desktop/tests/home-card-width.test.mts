import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARD_WIDTH_DEFAULT,
  CARD_WIDTH_MAX,
  CARD_WIDTH_MIN,
  clampCardWidth,
  dragCardWidth,
  parseCardWidths,
  serializeCardWidths,
} from '../src/home-card-width.ts';

test('a width is clamped into the range a card can render at', () => {
  assert.equal(clampCardWidth(300), 300);
  assert.equal(clampCardWidth(CARD_WIDTH_MIN - 40), CARD_WIDTH_MIN);
  assert.equal(clampCardWidth(CARD_WIDTH_MAX + 400), CARD_WIDTH_MAX);
  assert.equal(clampCardWidth(300.6), 301);
});

test('a non-finite width falls back to the default instead of spreading', () => {
  assert.equal(clampCardWidth(NaN), CARD_WIDTH_DEFAULT);
  assert.equal(clampCardWidth(Infinity), CARD_WIDTH_DEFAULT);
  assert.equal(clampCardWidth(-Infinity), CARD_WIDTH_DEFAULT);
});

test('dragging right widens and dragging left narrows', () => {
  assert.equal(dragCardWidth(300, 60), 360);
  assert.equal(dragCardWidth(300, -60), 240);
  assert.equal(dragCardWidth(300, 0), 300);
});

test('a drag cannot leave the allowed range, however far the pointer goes', () => {
  assert.equal(dragCardWidth(300, -5000), CARD_WIDTH_MIN);
  assert.equal(dragCardWidth(300, 5000), CARD_WIDTH_MAX);
});

test('a drag from a stretched card starts from that card width, not the default', () => {
  // The card fills a wide row; the first pixel of movement must not snap it
  // back to 260 — the pin has to start where the card actually is.
  assert.equal(dragCardWidth(1400, 1), 1401);
  assert.equal(dragCardWidth(1400, -100), 1300);
});

test('unusable drag inputs are tolerated', () => {
  assert.equal(dragCardWidth(NaN, 50), CARD_WIDTH_DEFAULT + 50);
  assert.equal(dragCardWidth(300, NaN), 300);
});

test('nothing stored reads as an empty map', () => {
  assert.deepEqual(parseCardWidths(null), {});
  assert.deepEqual(parseCardWidths(undefined), {});
  assert.deepEqual(parseCardWidths(''), {});
});

test('malformed stored data is dropped rather than thrown', () => {
  assert.deepEqual(parseCardWidths('{not json'), {});
  assert.deepEqual(parseCardWidths('"a string"'), {});
  assert.deepEqual(parseCardWidths('42'), {});
  assert.deepEqual(parseCardWidths('[1,2]'), {});
  assert.deepEqual(parseCardWidths('null'), {});
});

test('only numeric entries survive parsing', () => {
  const widths = parseCardWidths('{"ssh-prod":320,"bad":"320","worse":null,"x":true,"":400}');

  assert.deepEqual(widths, { 'ssh-prod': 320 });
});

test('stored out-of-range values are clamped on the way in', () => {
  const widths = parseCardWidths('{"tiny":10,"huge":99999}');

  assert.deepEqual(widths, { tiny: CARD_WIDTH_MIN, huge: CARD_WIDTH_MAX });
});

test('serialising sorts keys so identical state writes identical bytes', () => {
  const a = serializeCardWidths({ beta: 300, alpha: 400 });
  const b = serializeCardWidths({ alpha: 400, beta: 300 });

  assert.equal(a, b);
  assert.equal(a, '{"alpha":400,"beta":300}');
});

test('serialising clamps, and a round trip through storage is stable', () => {
  const stored = serializeCardWidths({ wide: CARD_WIDTH_MAX + 500, narrow: 1 });
  const back = parseCardWidths(stored);

  assert.deepEqual(back, { narrow: CARD_WIDTH_MIN, wide: CARD_WIDTH_MAX });
  assert.equal(serializeCardWidths(back), stored);
});
