import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real IPC wrapper with a deferred geometry read. This catches
// preference updates occurring between loadSettings() and updateSettings().
function harness() {
  let stored: Record<string, unknown> = {
    rememberWindowSize: true, windowWidth: 1000, windowHeight: 700, opacity: 1,
  };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = { isPipMode: false };
  const sandbox = {
    exports: {} as Record<string, (...args: any[]) => Promise<void>>,
    require: (name: string) => {
      if (name === './themes') return {
        loadSettings: () => ({ ...stored }),
        // Mirrors the real merge-into-latest behaviour of updateSettings().
        updateSettings: (patch: Record<string, unknown>) => { stored = { ...stored, ...patch }; return stored; },
      };
      if (name === './app-state') return state;
      if (name === './window-geometry-core') return {
        windowGeometryRole: () => 'owner',
        readStoredGeometry: () => null,
        mergeGeometry: (_previous: unknown, observed: unknown) => observed,
      };
      return {};
    },
    window: { devicePixelRatio: 1 },
    document: { documentElement: { classList: { contains: () => false } } },
    console, setTimeout, clearTimeout,
  };
  const source = fs.readFileSync(new URL('../src/window-geometry.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, sandbox);
  const win = {
    label: 'main',
    innerSize: async () => { await gate; return { width: 1100, height: 750 }; },
    outerPosition: async () => ({ x: 40, y: 50 }),
    isMaximized: async () => false,
  };
  return {
    start: () => sandbox.exports.persistMainWindowGeometry(win), release, state,
    patch: (patch: Record<string, unknown>) => { stored = { ...stored, ...patch }; },
    read: () => stored,
  };
}

test('geometry persistence retains preferences changed during IPC', async () => {
  const h = harness();
  const saving = h.start();
  h.patch({ opacity: 0.5 });
  h.release();
  await saving;
  assert.equal(h.read().opacity, 0.5);
  assert.equal(h.read().windowWidth, 1100);
});

test('disabling remembering during IPC prevents the pending geometry write', async () => {
  const h = harness();
  const saving = h.start();
  h.patch({ rememberWindowSize: false });
  h.release();
  await saving;
  assert.equal(h.read().rememberWindowSize, false);
  assert.equal(h.read().windowWidth, 1000);
});

test('entering PiP during IPC prevents saving the transient frame', async () => {
  const h = harness();
  const saving = h.start();
  h.state.isPipMode = true;
  h.release();
  await saving;
  assert.equal(h.read().windowWidth, 1000);
});

function overlappingHarness() {
  let stored: Record<string, unknown> = { rememberWindowSize: true, windowWidth: 1000, windowHeight: 700 };
  const releases: (() => void)[] = [];
  const sandbox = {
    exports: {} as Record<string, (...args: any[]) => Promise<void>>,
    require: (name: string) => {
      if (name === './themes') return { loadSettings: () => ({ ...stored }), updateSettings: (patch: Record<string, unknown>) => { stored = { ...stored, ...patch }; return stored; } };
      if (name === './app-state') return { isPipMode: false };
      if (name === './window-geometry-core') return { windowGeometryRole: () => 'owner', readStoredGeometry: () => null, mergeGeometry: (_: unknown, o: unknown) => o };
      return {};
    },
    window: { devicePixelRatio: 1 }, document: { documentElement: { classList: { contains: () => false } } },
    console, setTimeout, clearTimeout,
  };
  const source = fs.readFileSync(new URL('../src/window-geometry.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  const start = (width: number, flush = false) => sandbox.exports[flush ? 'flushMainWindowGeometry' : 'persistMainWindowGeometry']({
    label: 'main', innerSize: () => new Promise(resolve => releases.push(() => resolve({ width, height: 700 }))),
    outerPosition: async () => ({ x: width / 10, y: 50 }), isMaximized: async () => false,
  });
  return { start, releases, read: () => stored, patch: (patch: Record<string, unknown>) => { stored = { ...stored, ...patch }; } };
}

test('late older geometry reads cannot overwrite a newer close-time flush', async () => {
  const h = overlappingHarness();
  const older = h.start(1100), newer = h.start(1400, true);
  let flushed = false; void newer.then(() => { flushed = true; });
  await Promise.resolve(); assert.equal(flushed, false);
  h.releases[1](); await newer;
  assert.equal(h.read().windowWidth, 1400); assert.equal(h.read().windowX, 140);
  h.releases[0](); await older;
  assert.equal(h.read().windowWidth, 1400); assert.equal(h.read().windowX, 140);
});

test('older completion is ignored even before newer save finishes', async () => {
  const h = overlappingHarness();
  const older = h.start(1100), newer = h.start(1400);
  h.releases[0](); await older; assert.equal(h.read().windowWidth, 1000);
  h.patch({ opacity: 0.5 }); h.releases[1](); await newer;
  assert.equal(h.read().windowWidth, 1400); assert.equal(h.read().opacity, 0.5);
});
