/**
 * The server-info dock's single polling gate, driven for real.
 *
 * `canPoll()` exists because the "nothing visible means nothing to poll" rule
 * lived in one place while the paths that could *restart* the timer lived in two
 * others. The suite was green on both halves — `server-info-poll-cost` proves
 * focus / pointerdown resume, `server-info-panel-home-view` proves home/gallery
 * stop — and wrong in the combination, which is the only thing that matters here:
 * the dock is hidden by a *view switch*, not by the window, so no
 * `visibilitychange` ever arrives to stop the timer again, and the next click on
 * the dashboard put two SSH commands per tick behind a `display: none` panel.
 *
 * So every case below is a combination, and it drives the real `canPoll()`,
 * `resumePolling()` and `requestSysInfo()` out of the source with a stand-in
 * `this` — stubbing the gate would reproduce the same "each half looks right"
 * test that missed the regression.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const read = (name: string): string =>
  readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

/** The member's own parameter list, so default parameters survive the re-open. */
function paramList(body: string, name: string): string {
  const open = body.indexOf('(', body.indexOf(name));
  assert.ok(open > 0, `${name} has no parameter list`);
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '(') depth += 1;
    else if (body[i] === ')') {
      depth -= 1;
      if (depth === 0) return body.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced parameter list for ${name}`);
}

/** Slice a member out of the class and re-open it as a plain function. */
function methodSource(source: string, signature: string, name: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `server-info-panel.ts no longer declares ${signature.trim()}`);
  const end = source.indexOf('\n  }', start);
  assert.ok(end > start, `closing brace of ${signature.trim()} not found`);
  const body = source.slice(start, end).trimStart();
  // Everything from the parameter list on, minus the access modifier and the
  // return type — `private requestSysInfo(force = false): void {` has to keep its
  // parameter, or the re-opened copy fails with "force is not defined" and the
  // real reason (a slicing bug) is nowhere in the message.
  const params = paramList(body, name);
  const brace = body.indexOf('{', body.indexOf(params) + params.length);
  return `function ${name}${params} ${body.slice(brace)}\n}`;
}

const MEMBERS: Array<[string, string]> = [
  ['  private canPoll(): boolean {', 'canPoll'],
  ['  private resumePolling = (): void => {', 'resumePolling'],
  ['  private requestSysInfo(forceProcesses = false): void {', 'requestSysInfo'],
];

const PANEL = read('server-info-panel.ts');

const SECTION_JS = ts.transpileModule(
  MEMBERS.map(([signature, name]) => methodSource(PANEL, signature, name)).join('\n\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2021 } },
).outputText;

interface GateState {
  /** Panel pinned open (`_open`) — stays true when a view switch hides the dock. */
  open: boolean;
  home: boolean;
  gallery: boolean;
  /** `document.hidden`. */
  windowHidden: boolean;
  /** The panel element's inline display, `'none'` when hidden. */
  panelDisplay: string;
  sessionId: string | null;
  /** `hasRemoteServerInfo(sessionId)`. */
  remote: boolean;
}

const VISIBLE_SSH: GateState = {
  open: true,
  home: false,
  gallery: false,
  windowHidden: false,
  panelDisplay: '',
  sessionId: 'ssh-1',
  remote: true,
};

/**
 * A stand-in `this` with counters where the panel would touch the world: the
 * ordered trace is what the assertions read, because "did it send an SSH command"
 * is the only question that matters for a hidden dock.
 */
function gate(state: Partial<GateState> = {}) {
  const s: GateState = { ...VISIBLE_SSH, ...state };
  const calls: string[] = [];
  const fileManager = { requestServerInfo: (kind: string) => { calls.push(kind); } };

  const build = new Function(
    'isHomeView',
    'isGalleryView',
    'hasRemoteServerInfo',
    'document',
    'DrawerManager',
    'PROCESS_EVERY_TICKS',
    `${SECTION_JS}; return { canPoll, resumePolling, requestSysInfo };`,
  );
  const methods = build(
    s.home,
    s.gallery,
    (sessionId: string | null) => s.remote && !!sessionId,
    { hidden: s.windowHidden },
    { getFileManager: () => (s.remote && s.sessionId ? fileManager : undefined) },
    6,
  );

  const self = {
    _open: s.open,
    sessionId: s.sessionId,
    panel: { style: { display: s.panelDisplay } },
    timer: null as number | null,
    processTick: 0,
    // The gate itself is the real one, so `resumePolling` / `requestSysInfo` ask
    // the same predicate the class does rather than a re-derived copy of it.
    canPoll: methods.canPoll,
    // The real timer is observable through this counter: `resumePolling()` only
    // starts one, and `startPolling()` itself is covered elsewhere.
    startPolling: () => { calls.push('startPolling'); self.timer = 1; },
    requestSysInfo: methods.requestSysInfo,
  };

  return {
    s,
    calls,
    canPoll: () => methods.canPoll.call(self) as boolean,
    resume: () => methods.resumePolling.call(self),
    request: (force = false) => methods.requestSysInfo.call(self, force),
  };
}

// ── The regression: a dock hidden by a view switch, not by the window ──

test('a dock hidden behind the home view cannot be woken up by a click', () => {
  // Exactly the state syncToActiveSession() leaves behind: panel display:none,
  // polling stopped, but `_open` still true and the SSH session still active.
  const h = gate({ home: true, panelDisplay: 'none' });

  assert.equal(h.canPoll(), false, 'nothing is on screen, so nothing may be polled');
  h.resume();
  assert.deepEqual(h.calls, [], 'a dashboard click must not start the 5s poll or send a request');
});

test('the gallery view is the same case as home', () => {
  const h = gate({ gallery: true, panelDisplay: 'none' });
  assert.equal(h.canPoll(), false);
  h.resume();
  assert.deepEqual(h.calls, []);
});

// The view check stands on its own instead of leaning on the element having been
// hidden: hiding the dock is somebody else's step, and the whole bug was a path
// that did not depend on it having happened.
test('a view with no session stops polling even if the element still looks visible', () => {
  for (const view of [{ home: true }, { gallery: true }]) {
    const h = gate({ ...view, panelDisplay: '' });
    assert.equal(h.canPoll(), false, `must not poll in ${JSON.stringify(view)}`);
    h.resume();
    assert.deepEqual(h.calls, []);
  }
});

test('leaving home restores polling — the gate is a live check, not a latch', () => {
  const hidden = gate({ home: true, panelDisplay: 'none' });
  hidden.resume();
  assert.deepEqual(hidden.calls, []);

  const back = gate({ home: false, panelDisplay: '' });
  back.resume();
  assert.deepEqual(
    back.calls,
    ['startPolling', 'sysinfo', 'processes'],
    'a visible dock resumes and catches up immediately (force = a fresh process list)',
  );
});

// ── The other gates, same entry point ──

test('a background window does not poll, and does not catch up on a click', () => {
  const h = gate({ windowHidden: true });
  assert.equal(h.canPoll(), false);
  h.resume();
  assert.deepEqual(h.calls, [], 'no polling while the window is not visible');
});

test('a closed dock keeps polling off even with an SSH terminal on screen', () => {
  const h = gate({ open: false, panelDisplay: 'none' });
  assert.equal(h.canPoll(), false);
  h.resume();
  assert.deepEqual(h.calls, []);
});

test('no session, a local session and a JumpServer session all stay off', () => {
  for (const state of [{ sessionId: null }, { remote: false }, { sessionId: 'local-1', remote: false }]) {
    const h = gate({ ...state, panelDisplay: 'none' });
    assert.equal(h.canPoll(), false, `must not poll for ${JSON.stringify(state)}`);
    h.resume();
    assert.deepEqual(h.calls, []);
  }
});

// Positive control: without this, every assertion above would also pass if the
// gate simply refused everything.
test('a visible SSH dock polls, and the direct request path agrees', () => {
  const h = gate();
  assert.equal(h.canPoll(), true);
  h.request();
  assert.deepEqual(h.calls, ['sysinfo', 'processes'], 'the ordinary tick sends both');

  const again = gate();
  again.resume();
  assert.deepEqual(again.calls, ['startPolling', 'sysinfo', 'processes']);
});

// ── One gate, three entry points ──
//
// The bug was not a wrong predicate but a predicate that only some paths asked.
// These three assertions are what keeps it that way; the driven cases above are
// what prove the shared predicate is right.
test('every path that can start or send asks the same gate', () => {
  const callers: Array<[string, string]> = [
    ...MEMBERS.filter(([, name]) => name !== 'canPoll'),
    ['  syncToActiveSession(): void {', 'syncToActiveSession'],
  ];
  for (const [signature] of callers) {
    assert.ok(
      methodSource(PANEL, signature, 'probe').includes('this.canPoll()'),
      `${signature.trim()} must consult canPoll() instead of re-deriving the conditions`,
    );
  }
});
