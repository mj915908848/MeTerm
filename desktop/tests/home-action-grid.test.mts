import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOME_GRID_ACTIONS,
  HOME_WIDE_ACTIONS,
  planHomeActionGrid,
} from '../src/home-action-grid.ts';

test('the four session kinds fill the 2x2 grid in reading order', () => {
  const plan = planHomeActionGrid();

  assert.deepEqual(
    plan.slice(0, 4).map((s) => [s.kind, s.row, s.column]),
    [
      ['local', 0, 0],
      ['ssh', 0, 1],
      ['remote', 1, 0],
      ['jumpserver', 1, 1],
    ],
  );
  assert.ok(plan.slice(0, 4).every((s) => s.span === 1));
});

test('the phone entry keeps its place as a full-width row below the grid', () => {
  const plan = planHomeActionGrid();
  const phone = plan.find((s) => s.kind === 'phone');

  assert.ok(phone, 'phone pairing must not be dropped from the home view');
  assert.deepEqual([phone.row, phone.column, phone.span], [2, 0, 2]);
});

test('every action kind is placed exactly once', () => {
  const kinds = planHomeActionGrid().map((s) => s.kind);

  assert.equal(kinds.length, HOME_GRID_ACTIONS.length + HOME_WIDE_ACTIONS.length);
  assert.equal(new Set(kinds).size, kinds.length);
  assert.deepEqual(kinds, [...HOME_GRID_ACTIONS, ...HOME_WIDE_ACTIONS]);
});

test('a single column degenerates to one card per row', () => {
  const plan = planHomeActionGrid(1);

  assert.deepEqual(plan.map((s) => [s.row, s.column, s.span]), [
    [0, 0, 1],
    [1, 0, 1],
    [2, 0, 1],
    [3, 0, 1],
    [4, 0, 1],
  ]);
});

test('a partially filled last row still pushes wide cards down', () => {
  // Three columns: four grid cards leave the second row half empty, and the
  // phone card must start on the row after it — never sharing that row.
  const plan = planHomeActionGrid(3);
  const rows = plan.map((s) => s.row);

  assert.deepEqual(rows, [0, 0, 0, 1, 2]);
  assert.equal(plan.at(-1)?.span, 3);
});

test('a non-positive or fractional column count is rejected', () => {
  assert.throws(() => planHomeActionGrid(0), RangeError);
  assert.throws(() => planHomeActionGrid(-2), RangeError);
  assert.throws(() => planHomeActionGrid(1.5), RangeError);
});
