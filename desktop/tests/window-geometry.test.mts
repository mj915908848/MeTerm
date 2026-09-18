import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIN_RESTORABLE_HEIGHT,
  MIN_RESTORABLE_WIDTH,
  fitGeometryToScreen,
  fitGeometryToScreens,
  mergeGeometry,
  readStoredGeometry,
  windowGeometryRole,
  type ObservedWindowGeometry,
  type ScreenBounds,
  type WindowGeometry,
} from '../src/window-geometry-core.ts';

const LAPTOP: ScreenBounds = { x: 0, y: 0, width: 1440, height: 900 };

function stored(overrides: Record<string, unknown> = {}): WindowGeometry | null {
  return readStoredGeometry({
    width: 1280,
    height: 800,
    x: 40,
    y: 40,
    maximized: false,
    ...overrides,
  });
}

function observed(overrides: Partial<ObservedWindowGeometry> = {}): ObservedWindowGeometry {
  return { width: 1280, height: 800, x: 40, y: 40, maximized: false, ...overrides };
}

test('exactly one window owns the remembered geometry slot', () => {
  assert.equal(windowGeometryRole('main'), 'owner');
  // Extra windows inherit the size but never redefine the remembered frame.
  for (const label of ['window-1712345678901', 'window-42']) {
    assert.equal(windowGeometryRole(label), 'inherit-size', label);
  }
  // Utility windows share the settings object but must never touch this slot.
  for (const label of ['settings', 'editor', 'about', 'updater', 'jumpserver-browser', 'tray-dialog', 'drag-preview']) {
    assert.equal(windowGeometryRole(label), 'none', label);
  }
});

test('unusable stored size falls back to the OS default instead of a bogus restore', () => {
  assert.equal(stored({ width: undefined }), null);
  assert.equal(stored({ height: undefined }), null);
  assert.equal(stored({ width: 0, height: 0 }), null);
  assert.equal(stored({ width: '1280', height: 800 }), null);
  assert.equal(stored({ width: Number.NaN, height: 800 }), null);
  assert.equal(stored({ width: 120, height: 800 }), null, 'below the minimum width');
  assert.equal(stored({ width: 1280, height: 100 }), null, 'below the minimum height');
});

test('a stored frame is parsed back into logical pixels', () => {
  const geometry = stored({ x: 12.6, y: 30.4, maximized: true });
  assert.deepEqual(geometry, {
    width: 1280,
    height: 800,
    x: 12.6,
    y: 30.4,
    maximized: true,
  });
});

test('a frame remembered on a bigger display is clamped onto the current screen', () => {
  const target = fitGeometryToScreen(
    { width: 2560, height: 1440, x: 100, y: 100, maximized: false },
    LAPTOP,
  );
  assert.equal(target.width, LAPTOP.width);
  assert.equal(target.height, LAPTOP.height);
  assert.equal(target.x, 100);
  assert.equal(target.y, 100);
});

test('a position on a detached display is dropped so the OS places the window', () => {
  const target = fitGeometryToScreen(
    { width: 1280, height: 800, x: 3000, y: 200, maximized: false },
    LAPTOP,
  );
  assert.equal(target.x, null);
  assert.equal(target.y, null);
  assert.equal(target.width, 1280, 'the size is still honoured');
  assert.equal(target.height, 800);
});

test('a frame peeking only slightly into the screen is dropped, not half-restored', () => {
  const target = fitGeometryToScreen(
    { width: 1280, height: 800, x: LAPTOP.width - 10, y: 0, maximized: false },
    LAPTOP,
  );
  assert.equal(target.x, null);
  assert.equal(target.y, null);
});

test('a frame that is still comfortably visible keeps its position', () => {
  const target = fitGeometryToScreen(
    { width: 1280, height: 800, x: 120, y: 60, maximized: false },
    LAPTOP,
  );
  assert.deepEqual(target, { width: 1280, height: 800, x: 120, y: 60, maximized: false });
});

test('a size below the minimum is clamped up rather than rejected', () => {
  const target = fitGeometryToScreen(
    { width: MIN_RESTORABLE_WIDTH, height: MIN_RESTORABLE_HEIGHT, x: 0, y: 0, maximized: false },
    { x: 0, y: 0, width: 10, height: 10 },
  );
  assert.equal(target.width, MIN_RESTORABLE_WIDTH);
  assert.equal(target.height, MIN_RESTORABLE_HEIGHT);
});

test('maximizing records the flag but keeps the last un-maximized frame', () => {
  const remembered = stored()!;
  const maximizedFrame = observed({ width: 1440, height: 900, x: 0, y: 0, maximized: true });

  const next = mergeGeometry(remembered, maximizedFrame);

  assert.equal(next.maximized, true);
  assert.equal(next.width, 1280, 'the maximized frame must not become the preferred size');
  assert.equal(next.height, 800);
  assert.equal(next.x, 40);
  assert.equal(next.y, 40);
});

test('restoring a maximized window un-maximizes back to the remembered frame', () => {
  const maximized = mergeGeometry(stored(), observed({ width: 1440, height: 900, x: 0, y: 0, maximized: true }));
  // The user un-maximizes: now the real frame must be recorded again.
  const restored = mergeGeometry(maximized, observed({ width: 1100, height: 760, x: 25, y: 15, maximized: false }));

  assert.deepEqual(restored, { width: 1100, height: 760, x: 25, y: 15, maximized: false });
});

test('a maximized window with nothing remembered yet still yields a usable frame', () => {
  const next = mergeGeometry(null, observed({ width: 1440, height: 900, x: 0, y: 0, maximized: true }));
  assert.equal(next.maximized, true);
  assert.ok(next.width >= MIN_RESTORABLE_WIDTH);
  assert.ok(next.height >= MIN_RESTORABLE_HEIGHT);
});

test('save then restore round-trips the exact frame the user left behind', () => {
  const frame = observed({ width: 1234, height: 789, x: 210, y: 96 });

  const persisted = mergeGeometry(null, frame);
  const restored = fitGeometryToScreen(persisted, LAPTOP);

  assert.deepEqual(restored, { width: 1234, height: 789, x: 210, y: 96, maximized: false });
});


test('restore selects an attached secondary display instead of dropping its position', () => {
  const external = { x: 1440, y: 0, width: 2560, height: 1440 };
  const geometry = { width: 1800, height: 1000, x: 1600, y: 100, maximized: false };
  assert.deepEqual(fitGeometryToScreens(geometry, [LAPTOP, external], LAPTOP), geometry);
});

test('restore supports displays to the left and falls back when they are detached', () => {
  const external = { x: -1920, y: 0, width: 1920, height: 1080 };
  const geometry = { width: 1200, height: 800, x: -1800, y: 100, maximized: false };
  assert.deepEqual(fitGeometryToScreens(geometry, [LAPTOP, external], LAPTOP), geometry);
  const detached = fitGeometryToScreens(geometry, [LAPTOP], LAPTOP);
  assert.equal(detached.x, null);
  assert.equal(detached.y, null);
});
