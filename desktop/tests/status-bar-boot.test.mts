/**
 * Booting the local meterm backend used to announce itself on the status bar:
 * `setConnection('connecting', 'Starting...')` before the wait and
 * `setConnection('connected', 'Local')` after it. Neither is a session — the bar
 * says *which machine you are on* — so a freshly launched window with no session
 * at all advertised a live local connection. That was invisible while the bar
 * auto-hid, and became a visible lie as soon as `connected` was whitelisted in
 * `updateVisibility()`.
 *
 * The rule these tests pin: only a session (or a boot *failure*) may talk to the
 * bar. Callers that open a session set their own label right after awaiting
 * `ensureMeTermReady()`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const read = (name: string): string =>
  readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const SIGNATURE = 'export async function ensureMeTermReady(';

function functionSource(): string {
  const source = read('session-actions.ts');
  const start = source.indexOf(SIGNATURE);
  assert.ok(start >= 0, `session-actions.ts no longer declares ${SIGNATURE}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, 'closing brace of ensureMeTermReady() not found');
  // `getText()`-style extraction keeps `export`, which is invalid in a function
  // body injected through `new Function` — strip it.
  return source.slice(start, end + 2).replace(/^export\s+/, '');
}

const compiled = ts.transpileModule(functionSource(), {
  compilerOptions: { target: ts.ScriptTarget.ES2021 },
}).outputText;

interface Harness {
  ensureMeTermReady: () => Promise<boolean>;
  /** Everything the boot path did to the status bar, in order. */
  bar: string[];
  /** How many times the sidecar readiness wait was entered. */
  waits: () => number;
  pollers: string[];
  state: () => { metermReady: boolean; port: number; authToken: string };
}

function harness(waitForMeTerm: () => Promise<{ port: number; token: string }>): Harness {
  const bar: string[] = [];
  const pollers: string[] = [];
  let waits = 0;

  const build = new Function(
    'waitForMeTerm',
    'startPairPoller',
    'startRemoteSessionPoller',
    'StatusBar',
    `let metermReady = false, port = 0, authToken = '';
     const setPort = (v) => { port = v; };
     const setAuthToken = (v) => { authToken = v; };
     const setMetermReady = (v) => { metermReady = v; };
     ${compiled}
     return { ensureMeTermReady, state: () => ({ metermReady, port, authToken }) };`,
  );

  const api = build(
    () => { waits += 1; return waitForMeTerm(); },
    () => { pollers.push('pair'); },
    () => { pollers.push('remote'); },
    {
      setConnection: (status: string, label?: string) => { bar.push(`setConnection:${status}:${label ?? ''}`); },
      setError: (message: string) => { bar.push(`setError:${message}`); },
    },
  );

  return { ...api, bar, waits: () => waits, pollers, state: api.state };
}

test('a successful boot leaves the status bar describing nothing at all', async () => {
  const h = harness(async () => ({ port: 12345, token: 'tok' }));
  assert.equal(await h.ensureMeTermReady(), true, 'a healthy boot must report ready');
  assert.deepEqual(
    [...h.bar],
    [],
    'the bar must not advertise a local connection before a session exists',
  );
  assert.deepEqual({ ...h.state() }, { metermReady: true, port: 12345, authToken: 'tok' });
  assert.deepEqual([...h.pollers], ['pair', 'remote'], 'the pollers still start with the backend');
});

test('a second call is a no-op and never re-announces anything', async () => {
  const h = harness(async () => ({ port: 12345, token: 'tok' }));
  await h.ensureMeTermReady();
  await h.ensureMeTermReady();
  assert.equal(h.waits(), 1, 'the readiness wait must only run once');
  assert.deepEqual([...h.bar], [], 'the early return must not touch the bar either');
});

// A dead backend is the one thing that has no other surface: nothing else would
// ever tell the user why the window cannot open a session.
test('a failed boot still reports the error on the status bar', async () => {
  const h = harness(async () => { throw new Error('sidecar refused to start'); });
  assert.equal(await h.ensureMeTermReady(), false, 'a failed boot must report not-ready');
  assert.equal(h.bar.length, 1, 'exactly one message — the error');
  assert.ok(h.bar[0].startsWith('setError:'), `expected setError, got ${h.bar[0]}`);
  assert.ok(
    h.bar[0].includes('Failed to start meterm'),
    'the error must say what failed, not just that something did',
  );
  assert.equal(h.state().metermReady, false);
  assert.deepEqual([...h.pollers], [], 'no pollers may start for a backend that never came up');
});
