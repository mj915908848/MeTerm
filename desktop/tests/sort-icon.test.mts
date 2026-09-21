/**
 * The group sort control used to render the bare glyph "↕" (U+2195), which reads
 * as "up/down transfer" rather than "sort". It now renders the shared sort icon:
 * three bars sharing a left edge, longest on top. The icon is drawn on a 14-unit
 * grid and rendered at 14px (1:1) so its edges stay crisp.
 *
 * These guards pin the wiring, the shape's geometry (which is what makes it read
 * as a sort affordance rather than a blur), and the 1:1 grid/render contract.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** The raw SVG string of the `sort` entry in icons.ts. */
function sortIconSource(): string {
  const entry = read('../src/icons.ts').match(/^  sort: '([^']*)'/m);
  assert.ok(entry, 'icons.ts must define a "sort" entry');
  return entry![1];
}

/** The three bars of the sort icon, as numbers, in document (top-to-bottom) order. */
function sortIconBars(): { x: number; y: number; width: number; height: number; rx: number }[] {
  const svg = sortIconSource();
  const rects = [...svg.matchAll(/<rect\s+([^>]*?)\s*\/>/g)];
  assert.equal(rects.length, 3, `the sort icon must be exactly three bars (got ${rects.length})`);

  return rects.map(([, attrs]) => {
    const read_ = (name: string) => {
      const m = attrs.match(new RegExp(`(?:^|\\s)${name}="(-?[\\d.]+)"`));
      assert.ok(m, `each bar must declare ${name} as a plain number (attrs: ${attrs})`);
      return Number(m![1]);
    };
    return { x: read_('x'), y: read_('y'), width: read_('width'), height: read_('height'), rx: read_('rx') };
  });
}

test('the group sort control renders the shared sort icon, not a text glyph', () => {
  const src = read('../src/home-side.ts');
  assert.match(
    src,
    /sortButton\.innerHTML = icon\('sort'\);/,
    'the sort control must render the shared "sort" icon',
  );
  assert.doesNotMatch(
    src,
    /sortButton\.textContent/,
    'the sort control must not go back to a text glyph — "↕" means transfer, not sort',
  );
});

test('the sort icon is three bars sharing a left edge, longest on top', () => {
  const bars = sortIconBars();

  const lefts = bars.map((b) => b.x);
  assert.equal(
    new Set(lefts).size,
    1,
    `all three bars must share one left edge, or it stops reading as a sort icon (got ${lefts.join(', ')})`,
  );

  const widths = bars.map((b) => b.width);
  for (let i = 1; i < widths.length; i++) {
    assert.ok(
      widths[i] < widths[i - 1],
      `bars must shorten downwards (got ${widths.join(' → ')})`,
    );
  }

  const heights = bars.map((b) => b.height);
  assert.equal(
    new Set(heights).size,
    1,
    `all bars must be the same thickness (got ${heights.join(', ')})`,
  );

  for (const b of bars) {
    assert.ok(b.rx > 0, 'bars must have rounded ends, not square ones');
    assert.ok(
      b.rx <= b.height / 2,
      `a corner radius of ${b.rx} on a ${b.height}-tall bar would distort it (max ${b.height / 2})`,
    );
  }

  // Even spacing: the gaps between consecutive bars must match, and the ink must be
  // centred in the box. Uneven gaps or an off-centre stack is the difference between
  // "designed" and "blurry blob" at this size.
  const gaps = bars.slice(1).map((b, i) => b.y - (bars[i].y + bars[i].height));
  assert.equal(new Set(gaps).size, 1, `the bars must be evenly spaced (got gaps ${gaps.join(', ')})`);

  // Only the two trailing numbers of "0 0 W H" are capture groups; read the second
  // one explicitly rather than destructuring by position.
  const box = sortIconSource().match(/viewBox="0 0 (\d+) (\d+)"/);
  assert.ok(box, 'the sort icon must declare a "0 0 W H" viewBox');
  const boxHeight = Number(box![2]);

  const top = bars[0].y;
  const bottom = boxHeight - (bars[bars.length - 1].y + bars[bars.length - 1].height);
  assert.equal(top, bottom, `the stack must be vertically centred (got ${top} above vs ${bottom} below)`);
  assert.ok(bars[0].x > 0 && top > 0, 'the icon must be inset from the box edges, not flush against them');
  for (const b of bars) {
    assert.ok(
      b.y + b.height < boxHeight,
      `every bar must fit inside the ${boxHeight}-unit box (bar ends at ${b.y + b.height})`,
    );
  }
});

test('the sort icon is drawn on the same grid it renders at, so it stays crisp', () => {
  // The icon renders at exactly 14px, so it is drawn on a 14-unit grid. Scaling a
  // 24-unit grid down to 14px puts every coordinate on a fractional pixel, which is
  // what softened the glyph this replaced.
  assert.match(
    sortIconSource(),
    /viewBox="0 0 14 14"/,
    'the sort icon must use the 14-unit grid it is rendered at',
  );

  // Integer geometry is the other half of the 1:1 contract: a fractional x/y/width
  // would antialias an edge even at scale 1.
  for (const b of sortIconBars()) {
    for (const [name, value] of Object.entries(b)) {
      assert.ok(
        Number.isInteger(value),
        `bar ${name} must be an integer so the 1:1 render lands on pixel boundaries (got ${value})`,
      );
    }
  }

  const css = read('../src/styles/home.css');
  const rule = css.match(/\.hsg-sort svg\s*\{([^}]*)\}/);
  assert.ok(rule, '.hsg-sort svg must be sized explicitly');
  assert.match(rule![1], /width:\s*14px/, 'the sort icon must render at 14px to match its grid');
  assert.match(rule![1], /height:\s*14px/, 'the sort icon must render at 14px to match its grid');
});
