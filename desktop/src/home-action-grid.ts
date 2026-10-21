/**
 * Home action grid — layout plan for the full-page home's "new connection"
 * buttons.
 *
 * The full-page home shows local and SSH side by side in a two-column grid,
 * with JumpServer full-width underneath so the grid has no empty cell.
 *
 * Zero-dependency on purpose: the node test runner cannot load the modules that
 * pull in xterm or the Tauri APIs, so the placement rules live here, apart from
 * the DOM, and are covered by home-action-grid.test.mts.
 */

export type HomeActionKind = 'local' | 'ssh' | 'jumpserver';

/** Cards that fill the grid, in reading order. */
export const HOME_GRID_ACTIONS: readonly HomeActionKind[] = [
  'local',
  'ssh',
];

/** Cards that get a full-width row under the grid. */
export const HOME_WIDE_ACTIONS: readonly HomeActionKind[] = ['jumpserver'];

/** Columns in the grid. Kept in one place: the CSS grid uses the same number. */
export const HOME_GRID_COLUMNS = 2;

export interface HomeActionSlot {
  kind: HomeActionKind;
  /** 0-based row index. */
  row: number;
  /** 0-based column index. */
  column: number;
  /** Columns this card spans. */
  span: number;
}

/**
 * Place every home action card.
 *
 * Grid cards advance left-to-right, wrapping every `HOME_GRID_COLUMNS`; wide
 * cards each start a fresh row and span the full width.
 */
export function planHomeActionGrid(columns: number = HOME_GRID_COLUMNS): HomeActionSlot[] {
  if (!Number.isInteger(columns) || columns < 1) {
    throw new RangeError(`columns must be a positive integer, got ${columns}`);
  }

  const slots: HomeActionSlot[] = [];
  let row = 0;
  let column = 0;

  for (const kind of HOME_GRID_ACTIONS) {
    if (column >= columns) {
      column = 0;
      row += 1;
    }
    slots.push({ kind, row, column, span: 1 });
    column += 1;
  }

  // A partially filled last row still occupies a row: wide cards start below it.
  if (column > 0) row += 1;

  for (const kind of HOME_WIDE_ACTIONS) {
    slots.push({ kind, row, column: 0, span: columns });
    row += 1;
  }

  return slots;
}
