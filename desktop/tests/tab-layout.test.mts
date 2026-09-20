import assert from 'node:assert/strict';
import test from 'node:test';
import { planTabWidths } from '../src/tab-layout.ts';

// SSH tab: full width = the connection name plus the chrome around it, floor =
// the narrowest a tab may become before the row switches to scrolling.
const MIN = 108;
const mins = (count: number) => new Array(count).fill(MIN);

const total = (widths: readonly number[], gap: number, count: number) =>
  widths.reduce((a, b) => a + b, 0) + gap * (count - 1);

test('a row that fits gives every tab the width its name needs', () => {
  const full = [126, 119, 112, 170];
  const plan = planTabWidths({ fullWidths: full, minWidths: mins(4), available: 1200, gap: 6 });
  assert.deepEqual(plan.widths, full);
  assert.equal(plan.overflow, false);
});

test('when the row cannot fit, only the long names are trimmed', () => {
  // Full row needs 545px + gaps; only 520px is available.
  const full = [126, 119, 112, 170];
  const plan = planTabWidths({ fullWidths: full, minWidths: mins(4), available: 520, gap: 6 });

  assert.equal(plan.overflow, false);
  // The three short names stay whole, the long one shrinks to the shared cap.
  assert.deepEqual(plan.widths, [126, 119, 112, 145]);
  assert.ok(total(plan.widths, 6, 4) <= 520);
});

test('a trimmed row still fits the space it was given', () => {
  const full = [200, 180, 160, 300, 140];
  for (const available of [600, 700, 900, 1000]) {
    const plan = planTabWidths({ fullWidths: full, minWidths: mins(5), available, gap: 6 });
    assert.equal(plan.overflow, false);
    assert.ok(total(plan.widths, 6, 5) <= available, `total exceeds ${available}`);
    assert.ok(plan.widths.every((w, i) => w <= full[i] && w >= MIN));
  }
});

test('a single over-long name takes the room it can get', () => {
  const plan = planTabWidths({ fullWidths: [520], minWidths: [MIN], available: 300, gap: 6 });
  assert.deepEqual(plan.widths, [300]);
  assert.equal(plan.overflow, false);
});

test('overflow only once the floors themselves do not fit', () => {
  const full = [200, 200, 200, 200];
  const exact = 4 * MIN + 3 * 6;
  assert.equal(planTabWidths({ fullWidths: full, minWidths: mins(4), available: exact, gap: 6 }).overflow, false);
  assert.equal(planTabWidths({ fullWidths: full, minWidths: mins(4), available: exact - 1, gap: 6 }).overflow, true);
});

test('a row of floors falls back to the minimum widths', () => {
  const full = [126, 119, 112, 170, 130, 125, 140, 120, 115, 135, 145, 155];
  const plan = planTabWidths({ fullWidths: full, minWidths: mins(full.length), available: 1200, gap: 6 });
  assert.equal(plan.overflow, true);
  assert.deepEqual(plan.widths, mins(full.length));
});

test('the floor wins over a very short title, so tabs keep a usable size', () => {
  const plan = planTabWidths({ fullWidths: [74], minWidths: [MIN], available: 500, gap: 6 });
  assert.deepEqual(plan.widths, [MIN]);
});

test('empty and single-tab rows are handled without surprises', () => {
  assert.deepEqual(planTabWidths({ fullWidths: [], minWidths: [], available: 500, gap: 6 }), {
    widths: [],
    overflow: false,
  });
  assert.deepEqual(planTabWidths({ fullWidths: [126], minWidths: [MIN], available: 500, gap: 6 }), {
    widths: [126],
    overflow: false,
  });
});

test('a roomy row never pads tabs beyond their title', () => {
  const full = [126, 119, 112];
  const plan = planTabWidths({ fullWidths: full, minWidths: mins(3), available: 5000, gap: 6 });
  assert.deepEqual(plan.widths, full);
});
