import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * The toolbar's left row reads home → connections → session tools.
 *
 * DOM order is the order of the `appendChild` calls, so the position of the
 * connection button is one edit away from being lost, and nothing else in the
 * suite would notice. The home button stays first; the session-scoped buttons
 * (server info, file manager, gallery, new terminal) all follow the connection
 * entry.
 */

const src = readFileSync(new URL('../src/toolbar.ts', import.meta.url), 'utf8');

const at = (needle: string): number => {
  const index = src.indexOf(needle);
  assert.ok(index >= 0, `toolbar.ts no longer appends ${needle}`);
  return index;
};

test('the connections button sits second, directly after the home button', () => {
  const home = at('toolbarLeftEl.appendChild(homeViewBtn)');
  const conn = at('toolbarLeftEl.appendChild(connBtn)');

  assert.ok(conn > home, 'the connections button has to follow the home button');

  for (const later of [
    'toolbarLeftEl.appendChild(siBtn)',
    'toolbarLeftEl.appendChild(fmBtn)',
    'toolbarLeftEl.appendChild(galleryBtn)',
    'toolbarLeftEl.appendChild(newBtn)',
  ]) {
    assert.ok(at(later) > conn, `the connections button must come before ${later}`);
  }
});
