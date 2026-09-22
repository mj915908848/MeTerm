/**
 * The server-info panel is a left dock that pushes the terminal aside. Going
 * home (or to the gallery) only *hides* the terminal — it never closes the tab —
 * so the active session is still there and `hasRemoteServerInfo()` still answers
 * true. The panel therefore stayed on screen on top of the home dashboard, with
 * a toolbar that had already dropped its entry (session-scoped buttons are
 * hidden in the home view): a dock describing a session nothing else on screen
 * referred to.
 *
 * These tests drive the real `syncToActiveSession()` with a stand-in `this` so
 * the "nothing is displayed" case is exercised rather than pattern-matched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const read = (name: string): string =>
  readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const SYNC_SIGNATURE = '  syncToActiveSession(): void {';

/**
 * Slice `syncToActiveSession()` out of the class and re-open it as a plain
 * function: the body only touches module-level bindings and `this`, so calling it
 * with `.call(standInThis)` drives the real logic without booting the module
 * (which would drag in Tauri APIs).
 */
function syncFunctionSource(): string {
  const source = read('server-info-panel.ts');
  const start = source.indexOf(SYNC_SIGNATURE);
  assert.ok(start >= 0, `server-info-panel.ts no longer declares ${SYNC_SIGNATURE.trim()}`);
  const end = source.indexOf('\n  }', start);
  assert.ok(end > start, 'closing brace of syncToActiveSession() not found');
  const method = source
    .slice(start, end)
    .trimStart()
    .replace('syncToActiveSession(): void {', 'syncToActiveSession() {');
  return `function ${method}\n}`;
}

const compiled = ts.transpileModule(syncFunctionSource(), {
  compilerOptions: { target: ts.ScriptTarget.ES2021 },
}).outputText;

interface PanelRun {
  /** The real panel element's inline style — `display === 'none'` means hidden. */
  display: string;
  /** Ordered trace of the collaborators the panel may call while syncing. */
  calls: string[];
}

function syncPanel(state: {
  home: boolean;
  gallery: boolean;
  sessionId: string | null;
  ssh: boolean;
}): PanelRun {
  const calls: string[] = [];
  const build = new Function(
    'isHomeView',
    'isGalleryView',
    'TabManager',
    'hasRemoteServerInfo',
    'TerminalRegistry',
    `${compiled}; return syncToActiveSession;`,
  );
  const fn = build(
    state.home,
    state.gallery,
    { getActiveSessionId: () => state.sessionId },
    () => state.ssh,
    { resizeAll: () => { calls.push('resizeAll'); } },
  ) as () => void;

  const panel = { style: { display: '' } };
  fn.call({
    _open: true,
    sessionId: state.sessionId,
    panel,
    infoEl: null,
    compact: false,
    releaseContainer: () => { calls.push('releaseContainer'); },
    stopPolling: () => { calls.push('stopPolling'); },
    startPolling: () => { calls.push('startPolling'); },
    render: () => { calls.push('render'); },
  });

  return { display: panel.style.display, calls };
}

// The regression: an SSH tab is still open, the window is showing the home view.
test('the home view hides the dock even while the SSH tab is still open', () => {
  const run = syncPanel({ home: true, gallery: false, sessionId: 'ssh-1', ssh: true });
  assert.equal(run.display, 'none', 'the panel must be hidden on the home view');
  assert.ok(
    run.calls.includes('stopPolling'),
    'no session is on screen, so the 5s sysinfo poll must stop',
  );
  assert.ok(
    !run.calls.includes('startPolling'),
    'the poll must not restart on the path that just hid the panel',
  );
  assert.ok(!run.calls.includes('render'), 'a hidden panel must not be re-rendered');
});

// The gallery is the same situation as home: sessions as thumbnails, no terminal.
test('the gallery view hides the dock too', () => {
  const run = syncPanel({ home: false, gallery: true, sessionId: 'ssh-1', ssh: true });
  assert.equal(run.display, 'none', 'the panel must be hidden on the gallery view');
  assert.ok(run.calls.includes('stopPolling'), 'polling must stop for the gallery view');
});

// The panel has to come back when the SSH terminal is shown again — this is the
// other half of the contract and the reason the pin (`_open`) is kept.
test('an SSH terminal on screen shows the dock and restarts polling', () => {
  const run = syncPanel({ home: false, gallery: false, sessionId: 'ssh-1', ssh: true });
  assert.equal(run.display, '', 'the panel must be visible for an SSH session');
  const start = run.calls.indexOf('startPolling');
  assert.ok(start >= 0, 'polling must restart while the panel is visible');
  assert.ok(start < run.calls.indexOf('render'), 'the poll must start before the first render');
});

// Pre-existing rule kept in one place: a local session has no remote side.
test('a local session on screen hides the dock even outside home/gallery', () => {
  const run = syncPanel({ home: false, gallery: false, sessionId: 'local-1', ssh: false });
  assert.equal(run.display, 'none', 'a local session has nothing to describe');
});

// view-manager owns when the dock is synced; the gallery path used to be missing.
test('both no-terminal views sync the dock', () => {
  const source = read('view-manager.ts');
  for (const signature of ['export function showHomeView(): void {', 'export function showGalleryView(): void {']) {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found in view-manager.ts`);
    const body = source.slice(start, source.indexOf('\n}', start));
    assert.ok(
      body.includes('ServerInfoPanel.syncToActiveSession()'),
      `${signature} must sync the server-info panel — it displays no single session`,
    );
  }
});
