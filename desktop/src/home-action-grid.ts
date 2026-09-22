/**
 * Home action grid — layout plan for the full-page home's "new connection"
 * buttons.
 *
 * The restored full-page home shows the four session kinds in a 2×2 grid, the
 * way it did before v0.2.11 removed the page. The phone-pairing entry arrived
 * after that grid existed and has no cell of its own, so it renders full-width
 * underneath instead of being dropped — losing an entry the connections window
 * still offers would be a silent feature regression.
 *
 * Zero-dependency on purpose: the node test runner cannot load the modules that
 * pull in xterm or the Tauri APIs, so the placement rules live here, apart from
 * the DOM, and are covered by home-action-grid.test.mts.
 */

export type HomeActionKind = 'local' | 'ssh' | 'remote' | 'jumpserver' | 'phone';

/** Cards that fill the 2×2 grid, in reading order. */
export const HOME_GRID_ACTIONS: readonly HomeActionKind[] = [
  'local',
  'ssh',
  'remote',
  'jumpserver',
];

/** Cards that get a full-width row under the grid. */
export const HOME_WIDE_ACTIONS: readonly HomeActionKind[] = ['phone'];

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
