import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * The shell-hook injection machinery, cut out of `ai-tools-shell.ts` verbatim.
 *
 * The module cannot be imported (it pulls in the extensionless frontend graph),
 * so the whole section — `buildShellHook` plus the injection/retry bookkeeping —
 * is sliced by section markers and evaluated with every collaborator injected.
 * Slicing by markers (not by comment text) keeps working when lines move.
 */
function extractSection(): string {
  const source = readFileSync(new URL('../src/ai-tools-shell.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function buildShellHook(');
  const end = source.indexOf('// ─── Command Execution Waiters');
  assert.ok(start > 0 && end > start, 'injection section markers not found');
  return source.slice(start, end).replace(/\bexport /g, '');
}

const SECTION_JS = ts.transpileModule(extractSection(), {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
}).outputText;

/** Minimal escapeShellSingle, mirrored from ai-tools-core (single-quote escape). */
const escapeShellSingle = (s: string): string => s.replace(/'/g, "'\\''");

interface HarnessOptions {
  /** Serialized screen handed to the interactive-state detector. */
  screen?: string;
  /** xterm alternate-screen flag. */
  altScreen?: boolean;
  /** What the detector reports for that screen. */
  detectState?: string;
  hookInjected?: boolean;
  shellHookInjection?: boolean;
  /** Flip to false to simulate the session being closed. */
  hasSession?: boolean;
  /** Throw from serializeBuffer (unreadable terminal). */
  screenThrows?: boolean;
}

function harness(opts: HarnessOptions = {}) {
  const timers = new Map<number, () => void>();
  const timerDelays: number[] = [];
  let timerSeq = 0;
  const writes: string[] = [];
  const inputs: string[] = [];
  const markerCallbacks = new Map<string, (code: number) => void>();
  const shellTypes: Array<[string, string]> = [];
  const detectCalls: Array<[string, boolean]> = [];

  const mt = {
    terminal: { write: (s: string) => writes.push(s), scrollToBottom: () => {} },
    shellState: { hookInjected: opts.hookInjected ?? false },
  };

  const registry = {
    get: () => (opts.hasSession === false ? null : mt),
    serializeBuffer: () => {
      if (opts.screenThrows) throw new Error('no terminal');
      return opts.screen ?? '';
    },
    sendInput: (_sessionId: string, text: string) => { inputs.push(text); },
    onOscMarker: (_sessionId: string, id: string, cb: (code: number) => void) => {
      markerCallbacks.set(id, cb);
      return () => markerCallbacks.delete(id);
    },
  };

  const mod = new Function(
    'TerminalRegistry', 'loadSettings', 'detectInteractiveState', 'isAlternateScreen',
    'escapeShellSingle', 'setShellType', 'WATCH_DETECT_TAIL_CHARS', 'setTimeout', 'clearTimeout',
    `${SECTION_JS}
     return {
       injectShellHook, injectionBlocked, buildShellHook,
       hookState: _injectionState, BACKOFF: HOOK_RETRY_BACKOFF_MS, TIMEOUT: HOOK_INJECTION_TIMEOUT_MS,
     };`,
  )(
    registry,
    () => ({ shellHookInjection: opts.shellHookInjection ?? true }),
    (tail: string, alt: boolean) => {
      detectCalls.push([tail, alt]);
      return { state: opts.detectState ?? 'active' };
    },
    () => opts.altScreen ?? false,
    escapeShellSingle,
    (sessionId: string, shellType: string) => { shellTypes.push([sessionId, shellType]); },
    400,
    (fn: () => void, delayMs?: number) => {
      const id = ++timerSeq;
      timers.set(id, fn);
      timerDelays.push(delayMs ?? 0);
      return id;
    },
    (id: number) => { timers.delete(id); },
  ) as {
    injectShellHook: (sessionId: string) => boolean;
    injectionBlocked: (sessionId: string) => boolean;
    buildShellHook: (shellType: string) => string;
    hookState: Map<string, { failures: number; retryTimer: number | null }>;
    BACKOFF: number[];
    TIMEOUT: number;
  };

  /** Run every timer registered *now*, leaving newly-created ones for the next pass. */
  const runTimers = () => {
    const due = [...timers.entries()];
    for (const [id, fn] of due) {
      timers.delete(id);
      fn();
    }
  };

  return { mod, mt, writes, inputs, markerCallbacks, shellTypes, detectCalls, timers, timerDelays, runTimers, opts };
}

// ── §2.1: never type into a program that owns the screen ──────────

test('a TUI on the alternate screen blocks injection (its keystrokes are not ours to send)', () => {
  const h = harness({ altScreen: true });

  assert.equal(h.mod.injectionBlocked('s1'), true);
  assert.equal(h.mod.injectShellHook('s1'), false);
  assert.deepEqual(h.inputs, [], 'no Ctrl-U + command may be written into the TUI');
  assert.deepEqual(h.writes, [], 'and no alt-screen switch either');
});

test('a password or confirm prompt blocks injection', () => {
  for (const state of ['waiting_password', 'waiting_confirm', 'waiting_input', 'tui']) {
    const h = harness({ screen: '[sudo] password for mj: ', detectState: state });
    assert.equal(h.mod.injectionBlocked('s1'), true, `${state} must block`);
    assert.equal(h.mod.injectShellHook('s1'), false);
    assert.deepEqual(h.inputs, []);
  }
});

test('a bare shell prompt does not block injection', () => {
  const h = harness({ screen: 'mj@mac ~ % ', detectState: 'active' });

  assert.equal(h.mod.injectionBlocked('s1'), false);
  assert.equal(h.mod.injectShellHook('s1'), false); // async; see marker tests
  assert.equal(h.inputs.length, 1);
  assert.ok(h.inputs[0].startsWith('\x15'), 'injection is prefixed with Ctrl-U');
  assert.match(h.inputs[0], /eval '/, 'and carries the eval-quoted hook');
  assert.deepEqual(h.writes, ['\x1b[?1049h']);
});

test('alt-screen is decided without the detector, which otherwise gets the real flag', () => {
  const blocked = harness({ altScreen: true, detectState: 'active' });
  assert.equal(blocked.mod.injectionBlocked('s1'), true);
  assert.deepEqual(
    blocked.detectCalls,
    [],
    'the guard is explicit: a detector that stopped reporting tui must not silently disable it',
  );

  const normal = harness({ altScreen: false, detectState: 'active' });
  assert.equal(normal.mod.injectionBlocked('s1'), false);
  assert.equal(normal.detectCalls.length, 1);
  assert.equal(normal.detectCalls[0][1], false, 'the real alt-screen flag is forwarded');
});

test('an unreadable terminal does not block injection', () => {
  const h = harness({ screenThrows: true });
  assert.equal(h.mod.injectionBlocked('s1'), false);
});

// ── §2.2: failures retry with backoff instead of giving up forever ─

test('a successful handshake marks the hook injected and stops retrying', () => {
  const h = harness();
  h.mod.injectShellHook('s1');

  const [detectId, cb] = [...h.markerCallbacks.entries()][0];
  assert.ok(detectId.startsWith('det_'), 'detect marker id');
  cb(1);

  assert.equal(h.mt.shellState.hookInjected, true);
  assert.deepEqual(h.shellTypes, [['s1', 'zsh']]);
  assert.equal(h.writes.at(-1), '\x1b[?1049l', 'alt screen restored');
  assert.equal(h.mod.hookState.size, 0, 'retry bookkeeping cleared on success');
  assert.equal(h.timers.size, 0, 'handshake timeout cleared');
});

test('a blocked injection queues a retry instead of burning the one shot', () => {
  const h = harness({ altScreen: true });
  h.mod.injectShellHook('s1');

  const state = h.mod.hookState.get('s1');
  assert.equal(state?.failures, 1);
  assert.equal(h.timers.size, 1, 'a retry must be queued');
});

test('the handshake timeout schedules another attempt', () => {
  const h = harness();
  h.mod.injectShellHook('s1');
  assert.equal(h.inputs.length, 1);

  h.runTimers(); // fire the 3s handshake timeout
  assert.equal(h.mod.hookState.get('s1')?.failures, 1);
  assert.equal(h.timers.size, 1, 'retry queued after the timeout');

  h.runTimers(); // fire the backoff
  assert.equal(h.inputs.length, 2, 'the retry actually re-injects');
  assert.equal(h.writes.filter((w) => w === '\x1b[?1049l').length, 1, 'screen restored between attempts');
});

test('retries are bounded: one initial attempt plus one per backoff step', () => {
  const h = harness();
  h.mod.injectShellHook('s1');

  for (let i = 0; i < 12; i++) h.runTimers();

  const expectedAttempts = 1 + h.mod.BACKOFF.length;
  assert.equal(h.inputs.length, expectedAttempts);
  assert.equal(h.mod.hookState.get('s1')?.failures, expectedAttempts);
  assert.equal(h.timers.size, 0, 'nothing left pending');

  // And a later caller is refused rather than starting a new cycle.
  assert.equal(h.mod.injectShellHook('s1'), false);
  assert.equal(h.inputs.length, expectedAttempts);
  assert.deepEqual(h.mod.BACKOFF, [5_000, 15_000, 60_000]);
});

test('retry delays follow the backoff schedule (not a fixed re-inject loop)', () => {
  const h = harness();
  h.mod.injectShellHook('s1');
  for (let i = 0; i < 12; i++) h.runTimers();

  const retryDelays = h.timerDelays.filter((d) => d !== h.mod.TIMEOUT);
  assert.deepEqual(retryDelays, h.mod.BACKOFF, 'each retry must wait longer than the last');
  assert.deepEqual(h.mod.BACKOFF, [5_000, 15_000, 60_000]);
});

test('a retry whose session disappeared cleans up and does not re-inject', () => {
  const h = harness();
  h.mod.injectShellHook('s1');
  h.runTimers(); // handshake timeout -> retry queued
  const inputsBefore = h.inputs.length;

  h.opts.hasSession = false;
  h.runTimers();

  assert.equal(h.inputs.length, inputsBefore, 'no injection into a dead session');
  assert.equal(h.mod.hookState.size, 0, 'bookkeeping dropped with the session');
});

test('an already-hooked session is neither injected nor retried', () => {
  const h = harness({ hookInjected: true });
  assert.equal(h.mod.injectShellHook('s1'), true);
  assert.deepEqual(h.inputs, []);
  assert.deepEqual(h.writes, []);
  assert.equal(h.timers.size, 0);
});

test('respects the shellHookInjection setting', () => {
  const h = harness({ shellHookInjection: false });
  assert.equal(h.mod.injectShellHook('s1'), false);
  assert.deepEqual(h.inputs, []);
  assert.equal(h.mod.hookState.size, 0, 'a disabled feature must not accumulate state');
});
