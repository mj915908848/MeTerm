import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * Guards for the width behaviour of the home page's saved-connection cards.
 *
 * A card sits at a flat 260px on a row that wraps, and a drag on its right edge
 * pins a per-card width. Two things hold that together, and both fail silently
 * if undone:
 *
 *   1. The row must keep `flex-wrap: wrap`. A card pinned wider than the
 *      leftover space then starts a new line instead of pushing the row out
 *      sideways.
 *   2. A dragged width only wins if `data-fixed-width` switches the card to
 *      `flex: 0 0 auto` — and the attribute name in the TS (`dataset.fixedWidth`)
 *      has to line up with the selector in the CSS, which nothing else checks.
 *
 * These read the sources rather than the rendered page, so a broken invariant
 * shows up here instead of as a card that mysteriously will not stay wide.
 */

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8');

const css = read('../src/styles/home.css');
const leftPanel = read('../src/home-dashboard-left.ts');
const home = read('../src/home-dashboard.ts');
const widthModel = read('../src/home-card-width.ts');

// `doesNotMatch` passes vacuously on an empty string, so prove the sources were
// actually read before relying on any negative assertion below.
test('the sources under test were really read', () => {
  assert.ok(css.length > 1000, 'home.css came back suspiciously small');
  assert.ok(leftPanel.length > 1000, 'home-dashboard-left.ts came back suspiciously small');
  assert.match(css, /\.home-dash-group-card/);
  assert.match(leftPanel, /function makeCardResizable/);
});

/**
 * Body of the rule whose selector is `selector` on its own.
 *
 * Anchored to the start of a line on purpose: the same class also appears as a
 * descendant of a theme selector (`html[data-theme="light"] .home-dash-group-card`),
 * and an unanchored search would hand back the light-theme override — a body
 * with none of the layout properties being asserted.
 */
const ruleBody = (source: string, selector: string): string => {
  const match = source.match(
    new RegExp(`(?:^|\\n)[ \\t]*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`),
  );
  assert.ok(match, `no CSS rule found for "${selector}"`);
  return match[1];
};

/** First numeric value of a property, e.g. `pxOf(body, 'width')`. */
const pxOf = (body: string, prop: string): number => {
  const match = body.match(new RegExp(`${prop}:\\s*(\\d+(?:\\.\\d+)?)px`));
  assert.ok(match, `no px value for "${prop}" in: ${body.trim()}`);
  return Number(match[1]);
};

// ── A card holds its own width; the row wraps around it ──

test('a card sits at a flat 260px instead of stretching to fill the row', () => {
  const body = ruleBody(css, '.home-dash-group-card');

  assert.match(
    body,
    /flex:\s*0\s+0\s+260px/,
    'the cards are meant to hold a flat 260px, not grow into the row',
  );
  assert.doesNotMatch(
    body,
    /flex:\s*1\s+1\s+260px/,
    'flex-grow stretches every card across the row — turned off on request',
  );
});

test('the card grid wraps, so an extra card starts a new row', () => {
  const body = ruleBody(css, '.home-dash-groups-grid');

  assert.match(body, /flex-wrap:\s*wrap/);
});

test('the row spacing is left alone', () => {
  const body = ruleBody(css, '.home-dash-groups-grid');

  assert.match(body, /gap:\s*12px/, 'the 12px gutter is deliberately unchanged');
});

test('a card cannot be dragged narrower than its content needs', () => {
  const body = ruleBody(css, '.home-dash-group-card');

  assert.match(body, /min-width:\s*220px/);
});

// ── The stylesheet default and the width model have to agree ──

test('the width a card renders at is the width the model calls the default', () => {
  const flex = ruleBody(css, '.home-dash-group-card').match(/flex:\s*0\s+0\s+(\d+(?:\.\d+)?)px/);
  assert.ok(flex, 'the card has no px flex-basis to compare against');

  const declared = widthModel.match(/CARD_WIDTH_DEFAULT\s*=\s*(\d+(?:\.\d+)?)/);
  assert.ok(declared, 'CARD_WIDTH_DEFAULT is gone from home-card-width.ts');

  assert.equal(
    Number(flex[1]),
    Number(declared[1]),
    'a card renders at one width while the model clamps to another',
  );
});

// ── A dragged width wins, and resetting it hands the card back ──

test('the pinned width stops the card growing', () => {
  const body = ruleBody(css, '.home-dash-group-card[data-fixed-width]');

  assert.match(
    body,
    /flex:\s*0\s+0\s+auto/,
    'a pinned card that still grew would ignore the width the user dragged',
  );
});

test('the attribute the TS sets is the one the CSS keys off', () => {
  assert.match(
    leftPanel,
    /card\.dataset\.fixedWidth\s*=\s*'1'/,
    'the JS must mark the card for the CSS rule',
  );
  assert.match(leftPanel, /removeAttribute\('data-fixed-width'\)/);
  assert.match(css, /\[data-fixed-width\]/);
});

// ── The handle sits off the card's own scrollbar ──

test('the resize handle is a col-resize strip on the right edge', () => {
  const body = ruleBody(css, '.home-dash-card-resizer');

  assert.match(body, /cursor:\s*col-resize/);
  assert.equal(pxOf(body, 'width'), 8);
});

test('the overlay scrollbar is pushed clear of the handle by the same amount', () => {
  const handleWidth = pxOf(ruleBody(css, '.home-dash-card-resizer'), 'width');
  const bar = ruleBody(css, '.home-dash-group-card > .overlay-sb');
  const offset = bar.match(/translateX\(-(\d+(?:\.\d+)?)px\)/);

  assert.ok(offset, 'the card scrollbar is not offset, so it sits under the handle');
  assert.equal(
    Number(offset[1]),
    handleWidth,
    'handle and scrollbar offset must match or one overlaps the other',
  );
});

// ── Both card kinds and the recent track are wired up ──

test('every group card gets a handle, named groups and type buckets alike', () => {
  const calls = leftPanel.match(/makeCardResizable\(card, /g) ?? [];

  assert.equal(calls.length, 2, 'the named-group and type-group cards both need one');
  assert.match(leftPanel, /makeCardResizable\(card, groupName \?\? '@ungrouped'\)/);
  assert.match(leftPanel, /makeCardResizable\(card, `__type:\$\{type\}`\)/);
});

test('recent activity is the horizontal card track, not a vertical list', () => {
  assert.match(leftPanel, /function renderRecentActivity\(query: string\)/);
  assert.match(leftPanel, /className = 'home-dash-recent-track'/);
  assert.match(leftPanel, /home-dash-recent-card home-dash-recent-\$\{item\.type\}/);
  assert.match(ruleBody(css, '.home-dash-recent-track'), /overflow-x:\s*auto/);
  assert.match(ruleBody(css, '.home-dash-recent-card'), /flex:\s*0\s+0\s+auto/);
});

test('the home page mounts the track and hides the block when it is empty', () => {
  assert.match(home, /recentSection\.id = 'home-recent-activity'/);
  assert.match(home, /renderRecentActivity\(''\)/);
  assert.match(ruleBody(css, '.home-dashboard #home-recent-activity:empty'), /display:\s*none/);
});
