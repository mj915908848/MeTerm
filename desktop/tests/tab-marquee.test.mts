import assert from 'node:assert/strict';
import test from 'node:test';
import { syncTabMarqueeFor } from '../src/tab-marquee.ts';

/**
 * Minimal stand-in for the DOM surface `syncTabMarqueeFor` touches. The
 * real function only ever reads `scrollWidth`/`clientWidth` and writes
 * style/classes, so a hand-rolled stub keeps this test free of a DOM.
 */
function fakeTab(opts: {
  textWidth?: number;
  trackWidth?: number;
  missingSelector?: string;
} = {}) {
  const classes = new Set<string>();
  const vars = new Map<string, string>();
  const inner = { style: { transform: '' } };

  const elements: Record<string, unknown> = {
    '.title-tab-text.primary': { scrollWidth: opts.textWidth ?? 100 },
    '.title-tab-track': { clientWidth: opts.trackWidth ?? 100 },
    '.title-tab-track-inner': inner,
    '.tab-close': {},
  };
  if (opts.missingSelector) delete elements[opts.missingSelector];

  const node = {
    querySelector: (sel: string) => elements[sel] ?? null,
    style: {
      setProperty: (key: string, value: string) => { vars.set(key, value); },
      removeProperty: (key: string) => { vars.delete(key); },
    },
    classList: {
      add: (c: string) => { classes.add(c); },
      remove: (c: string) => { classes.delete(c); },
    },
  };

  return {
    node: node as unknown as HTMLElement,
    classes,
    vars,
    inner,
  };
}

test('an overflowing label gets the marquee class and shift distance', () => {
  const { node, classes, vars } = fakeTab({ textWidth: 200, trackWidth: 100 });
  syncTabMarqueeFor(node);
  assert.ok(classes.has('is-overflowing'));
  // Default gap is 24px, so the shift is the text width plus the gap.
  assert.equal(vars.get('--marquee-shift'), '224px');
});

test('a label that fits clears any previous marquee state', () => {
  const { node, classes, vars, inner } = fakeTab({ textWidth: 100, trackWidth: 100 });
  classes.add('is-overflowing');
  vars.set('--marquee-shift', '999px');
  inner.style.transform = 'translateX(-40px)';

  syncTabMarqueeFor(node);

  assert.ok(!classes.has('is-overflowing'));
  assert.equal(vars.has('--marquee-shift'), false);
  assert.equal(inner.style.transform, 'translateX(0)');
});

test('a 2px slack keeps sub-pixel rounding from starting a marquee', () => {
  const at = fakeTab({ textWidth: 102, trackWidth: 100 });
  syncTabMarqueeFor(at.node);
  assert.ok(!at.classes.has('is-overflowing'), '102 vs 100 sits inside the 2px slack');

  const past = fakeTab({ textWidth: 103, trackWidth: 100 });
  syncTabMarqueeFor(past.node);
  assert.ok(past.classes.has('is-overflowing'), '103 vs 100 is a real overflow');
});

test('a partially built tab is ignored instead of throwing', () => {
  // The editor used to ship exactly this shape — no .primary, no
  // .duplicate — which is why its long names never marquee'd.
  for (const missing of [
    '.title-tab-text.primary',
    '.title-tab-track',
    '.title-tab-track-inner',
    '.tab-close',
  ]) {
    const { node, classes, vars } = fakeTab({ textWidth: 300, missingSelector: missing });
    assert.doesNotThrow(() => syncTabMarqueeFor(node));
    assert.equal(classes.size, 0, `missing ${missing} should skip the tab`);
    assert.equal(vars.size, 0, `missing ${missing} should not set --marquee-shift`);
  }
});
