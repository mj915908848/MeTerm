import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  // Un-export the sliced declarations — the slice is evaluated as one script,
  // not a module. Anchored to the start of a line so it cannot reach inside the
  // *strings*: `export HISTCONTROL=…` in the injected body is not decoration,
  // it is the only form of that assignment fish can parse, and stripping it here
  // would have the tests parse and run a command production never sends.
  return source.slice(start, end).replace(/^export /gm, '');
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
  /**
   * What `ssh_host_identity` answers: a host identity string (an SSH session with
   * an exec channel), or null/absent for "this session has no exec channel"
   * (local, JumpServer). `probeThrows` models the call itself failing.
   */
  hostIdentity?: string | null;
  probeThrows?: boolean;
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
  const probeCalls: string[] = [];

  const mt = {
    terminal: { write: (s: string) => writes.push(s), scrollToBottom: () => {} },
    shellState: { hookInjected: opts.hookInjected ?? false, lastUserInputAt: 0 },
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
    'invoke',
    `${SECTION_JS}
     return {
       injectShellHook, injectionBlocked, buildShellHook,
       hookState: _injectionState, BACKOFF: HOOK_RETRY_BACKOFF_MS, TIMEOUT: HOOK_INJECTION_TIMEOUT_MS,
       hostIdentity: _hostIdentity, FOREIGN_CODE: HOOK_FOREIGN_HOST_CODE,
       HOST_IDENTITY_EXPR,
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
    (command: string, args: { sessionId: string }) => {
      probeCalls.push(`${command}:${args.sessionId}`);
      if (opts.probeThrows) return Promise.reject(new Error('SSH exec not available'));
      return Promise.resolve(opts.hostIdentity ?? null);
    },
  ) as {
    injectShellHook: (sessionId: string) => boolean;
    injectionBlocked: (sessionId: string) => boolean;
    buildShellHook: (shellType: string) => string;
    hookState: Map<string, { failures: number; blocked: number; startedAt: number; retryTimer: number | null }>;
    hostIdentity: Map<string, { status: string; value?: string }>;
    FOREIGN_CODE: number;
    BACKOFF: number[];
    TIMEOUT: number;
    HOST_IDENTITY_EXPR: string;
  };

  /** Run every timer registered *now*, leaving newly-created ones for the next pass. */
  const runTimers = () => {
    const due = [...timers.entries()];
    for (const [id, fn] of due) {
      timers.delete(id);
      fn();
    }
  };

  /**
   * Let the host-identity probe finish.
   *
   * The first `injectShellHook` call for a session asks which host is on the
   * other end and returns before typing anything; the probe's continuation
   * re-enters and does the injection. Every assertion about an injection
   * therefore has to run after this, not after the call.
   */
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
  };

  return { mod, mt, writes, inputs, markerCallbacks, shellTypes, detectCalls, probeCalls, timers, timerDelays, runTimers, settle, opts };
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

test('a bare shell prompt does not block injection', async () => {
  const h = harness({ screen: 'mj@mac ~ % ', detectState: 'active' });

  assert.equal(h.mod.injectionBlocked('s1'), false);
  assert.equal(h.mod.injectShellHook('s1'), false); // async; see marker tests
  await h.settle();
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

test('a successful handshake marks the hook injected and stops retrying', async () => {
  const h = harness();
  h.mod.injectShellHook('s1');
  await h.settle();

  const [detectId, cb] = [...h.markerCallbacks.entries()][0];
  assert.ok(detectId.startsWith('det_'), 'detect marker id');
  cb(1);

  assert.equal(h.mt.shellState.hookInjected, true);
  assert.deepEqual(h.shellTypes, [['s1', 'zsh']]);
  assert.equal(h.writes.at(-1), '\x1b[?1049l', 'alt screen restored');
  assert.equal(h.mod.hookState.size, 0, 'retry bookkeeping cleared on success');
  assert.equal(h.timers.size, 0, 'handshake timeout cleared');
});

test('a blocked injection queues a retry without spending the handshake budget', () => {
  const h = harness({ altScreen: true });
  h.mod.injectShellHook('s1');

  const state = h.mod.hookState.get('s1');
  assert.equal(state?.failures, 0, 'nothing was sent, so nothing was spent');
  assert.equal(state?.blocked, 1);
  assert.equal(h.timers.size, 1, 'a retry must be queued');
});

test('blocked attempts never exhaust the chain, and the hook lands once the screen frees up', async () => {
  const h = harness({ altScreen: true });
  h.mod.injectShellHook('s1');
  await h.settle();

  for (let i = 0; i < 10; i++) h.runTimers(); // a long stay inside vim/less/top

  assert.deepEqual(h.inputs, [], 'nothing may be typed into the TUI');
  assert.equal(h.mod.hookState.get('s1')?.failures, 0, 'still nothing spent');
  assert.equal(h.timers.size, 1, 'still coming back — this chain cannot run out');
  assert.deepEqual(
    h.timerDelays.slice(-3),
    [60_000, 60_000, 60_000],
    'blocked waits saturate at the longest tier instead of running out',
  );

  h.opts.altScreen = false; // the user leaves the TUI, back at a shell prompt
  h.runTimers();
  await h.settle();

  assert.equal(h.inputs.length, 1, 'the next attempt injects');
  const [, callback] = [...h.markerCallbacks.entries()][0];
  callback(1);
  assert.equal(h.mt.shellState.hookInjected, true, 'and the hook lands');
  assert.equal(h.mod.hookState.size, 0, 'bookkeeping cleared on success');
});

test('the handshake timeout schedules another attempt', async () => {
  const h = harness();
  h.mod.injectShellHook('s1');
  await h.settle();
  assert.equal(h.inputs.length, 1);

  h.runTimers(); // fire the 3s handshake timeout
  assert.equal(h.mod.hookState.get('s1')?.failures, 1);
  assert.equal(h.timers.size, 1, 'retry queued after the timeout');

  h.runTimers(); // fire the backoff
  assert.equal(h.inputs.length, 2, 'the retry actually re-injects');
  assert.equal(h.writes.filter((w) => w === '\x1b[?1049l').length, 1, 'screen restored between attempts');
});

test('retries are bounded: one initial attempt plus one per backoff step', async () => {
  const h = harness();
  h.mod.injectShellHook('s1');
  await h.settle();

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

test('retry delays follow the backoff schedule (not a fixed re-inject loop)', async () => {
  const h = harness();
  h.mod.injectShellHook('s1');
  await h.settle();
  for (let i = 0; i < 12; i++) h.runTimers();

  const retryDelays = h.timerDelays.filter((d) => d !== h.mod.TIMEOUT);
  assert.deepEqual(retryDelays, h.mod.BACKOFF, 'each retry must wait longer than the last');
  assert.deepEqual(h.mod.BACKOFF, [5_000, 15_000, 60_000]);
});

// ── §4: a retry must not land on a nested `ssh`'s remote shell ───
//
// `injectionBlocked()` cannot tell a nested remote prompt from ours, so a retry
// that keeps firing after the user has driven the terminal can install the hook
// on the *other* host and then mark this session as hooked — which is worse than
// staying hookless, because `hookInjected` is what switches the screen-tail
// fallbacks back off.
//
// Two defences exist, and which one applies decides what "the user typed" is
// allowed to mean:
//
// - The command's own host check (§5) answers the question outright, so a
//   keypress is irrelevant to it.
// - The typing restraint below is a *guess* from keystrokes, kept for the
//   sessions that have no identity to compare against (the default harness here:
//   `hostIdentity` unset means "no exec channel").
//
// The tests in this group pin the restraint where it is the only defence; the
// guarded-session counterpart lives at the end of the group, because the
// difference between the two is the whole point.

test('a retry chain gives up once the user has driven the terminal', async () => {
  const h = harness();
  h.mod.injectShellHook('s1');
  await h.settle();
  assert.equal(h.inputs.length, 1, 'the initial attempt is sent');

  h.runTimers(); // the 3s handshake goes unanswered -> a retry is queued
  assert.equal(h.mod.hookState.get('s1')?.failures, 1);

  h.mt.shellState.lastUserInputAt = Date.now(); // the user typed since it started
  h.runTimers(); // the 5s backoff fires

  assert.equal(h.inputs.length, 1, 'no injection into a shell that may not be ours');
  assert.equal(h.mod.hookState.size, 0, 'the chain is dropped, not left half spent');
});

test('a dropped chain does not blacklist the session: a later call injects again', async () => {
  const h = harness();
  h.mod.injectShellHook('s1');
  await h.settle();
  h.runTimers();
  h.mt.shellState.lastUserInputAt = Date.now();
  h.runTimers(); // gated: the chain is dropped
  assert.equal(h.inputs.length, 1);

  h.mod.injectShellHook('s1'); // e.g. the next agent turn
  await h.settle();
  assert.equal(h.inputs.length, 2, 'a fresh call injects — a dropped chain spent nothing');
  assert.equal(h.mod.hookState.get('s1')?.failures, 0, 'and it starts with a clean budget');
});

/**
 * The counterpart of the two tests above, and the one that matters in practice.
 *
 * Identical keystroke, opposite outcome — because the session here has an
 * identity, so the command itself can tell a nested shell from ours and the
 * keystroke has nothing to add. Leaving `vim` with `q` is typing: under the
 * guess-only rule it cancelled the chain, and since the capture path
 * unsubscribes from the output stream on its first attempt, nothing ever
 * retried. A user who opened a file while the hook was being installed ended up
 * with a session that silently had no hook for the rest of its life.
 */
test('a guarded session keeps retrying even though the user typed — leaving a TUI is typing too', async () => {
  const h = harness({ hostIdentity: 'host-A' });
  h.mod.injectShellHook('s1');
  await h.settle();
  assert.equal(h.inputs.length, 1, 'the initial attempt is sent');

  h.runTimers(); // the 3s handshake goes unanswered -> a retry is queued
  assert.equal(h.mod.hookState.get('s1')?.failures, 1);

  h.mt.shellState.lastUserInputAt = Date.now(); // e.g. `q` out of vim
  h.runTimers(); // the 5s backoff fires

  assert.equal(
    h.inputs.length, 2,
    'a keystroke must not cancel a chain the command\'s own host check already guards',
  );
  assert.equal(h.mod.hookState.size, 1, 'the chain is still alive and accounting');
});

test('a retry whose session disappeared cleans up and does not re-inject', async () => {
  const h = harness();
  h.mod.injectShellHook('s1');
  await h.settle();
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

// ── §5: the host-identity gate (what the detector above cannot see) ─
//
// `injectionBlocked()` is blind to the case that matters most: a nested `ssh`
// shows a bare shell prompt the detector reads as `active`, so the command lands
// on the other host and the 7766 handshake *succeeds* there. The exec channel is
// the signal the screen cannot give — it is a second channel on the connection
// we dialled, so the host it reports is the host we dialled. The injected command
// computes the same identity where it actually lands, and only a match installs
// anything. See `HostIdentity`.

/** The newest registered detect marker, alongside its resolver. */
const latestMarker = (h: ReturnType<typeof harness>): [string, (code: number) => void] =>
  [...h.markerCallbacks.entries()].at(-1)!;

test('nothing is typed before the connected host has been identified', async () => {
  const h = harness();

  assert.equal(h.mod.injectShellHook('s1'), false, 'the first call only asks');
  assert.deepEqual(h.inputs, [], 'no Ctrl-U + command may go out over an unverified prompt');
  assert.deepEqual(h.writes, [], 'and no alt-screen switch either');
  assert.deepEqual(h.probeCalls, ['ssh_host_identity:s1']);
  assert.equal(h.mod.hookState.size, 0, 'a probe wait is not an attempt: nothing is booked against the chain');
  assert.equal(h.timers.size, 0, 'and nothing is queued — the probe re-enters on its own');

  await h.settle();
  assert.equal(h.inputs.length, 1, 'the probe continuation performs the injection');
});

test('a second call while the probe is in flight neither re-asks nor types', async () => {
  const h = harness();
  h.mod.injectShellHook('s1');
  assert.equal(h.mod.injectShellHook('s1'), false);

  assert.deepEqual(h.probeCalls, ['ssh_host_identity:s1'], 'one probe per session, not one per call');
  await h.settle();
  assert.equal(h.inputs.length, 1, 'and exactly one injection');
});

test('an identified host guards the command with its identity', async () => {
  const h = harness({ hostIdentity: 'abc123|mac|boot-7' });
  h.mod.injectShellHook('s1');
  await h.settle();

  assert.equal(h.inputs.length, 1);
  assert.ok(
    h.inputs[0].includes('__meterm_id='),
    'the injected command has to compute the identity *where it lands* — that is the shell under suspicion',
  );
  assert.ok(
    h.inputs[0].includes('if [ "$__meterm_id" = "$1" ]'),
    'and compare it against the answer from the exec channel; this comparison is the entire guard',
  );
  assert.ok(
    h.inputs[0].includes("meterm 'abc123|mac|boot-7'"),
    'the expected identity arrives as an argument to that comparison, so a hostname holding quotes '
    + 'or `$` is inert rather than being read as shell syntax',
  );
  assert.equal(
    (h.inputs[0].match(/sh -c '/g) ?? []).length,
    3,
    'the check is delegated to a POSIX `sh` — a shell every dialect can drive — and it has to ride '
    + 'along in *every* branch (`zsh`, `bash`, `fish`), since only the foreground shell knows which '
    + 'one it is. A branch that ships without it is a branch that installs on a nested ssh\'s host',
  );
  assert.match(
    h.inputs[0],
    /\\033\]7766;det_[^;]+;9\\007/,
    'the mismatch branch answers with code 9 on the detect marker — outside 0..3, so the frontend can '
    + 'never read it as a successful handshake',
  );
});

test('a session with no exec channel injects unguarded, as it always did', async () => {
  const h = harness({ hostIdentity: null });
  h.mod.injectShellHook('s1');
  await h.settle();

  assert.equal(h.inputs.length, 1, 'local and JumpServer sessions have nothing to compare against');
  assert.ok(!h.inputs[0].includes('__meterm_id='), 'so no comparison is added to their command');
});

test('a failed probe degrades the same way instead of blocking injection', async () => {
  const h = harness({ probeThrows: true });
  h.mod.injectShellHook('s1');
  await h.settle();

  assert.equal(h.inputs.length, 1, 'an unavailable guard must never become a missing feature');
  assert.ok(!h.inputs[0].includes('__meterm_id='));
});

test('the identity is asked once per session and reused by every later attempt', async () => {
  const h = harness({ hostIdentity: 'abc123|mac|boot-7' });
  h.mod.injectShellHook('s1');
  await h.settle();
  h.runTimers(); // the 3s handshake times out
  h.runTimers(); // the retry goes out

  assert.equal(h.inputs.length, 2, 'the retry really did re-inject');
  assert.deepEqual(h.probeCalls, ['ssh_host_identity:s1'], 'the answer is reused, not re-asked per attempt');
  assert.ok(h.inputs[1].includes("meterm 'abc123|mac|boot-7'"), 'and the retry is guarded too');
});

test('a foreign-host report stops the chain instead of retrying into it', async () => {
  const h = harness({ hostIdentity: 'abc123|mac|boot-7' });
  h.mod.injectShellHook('s1');
  await h.settle();
  assert.equal(h.inputs.length, 1);

  const [detectId, cb] = latestMarker(h);
  assert.ok(detectId.startsWith('det_'), 'the mismatch arrives on the detect marker');
  cb(h.mod.FOREIGN_CODE);

  assert.equal(h.mt.shellState.hookInjected, false, 'the hook was never installed anywhere');
  assert.equal(h.mod.hookState.size, 0, 'and the chain is dropped rather than left half spent');
  assert.equal(h.timers.size, 0, 'nothing is queued to retry into a shell that is not ours');
  assert.equal(h.mod.hostIdentity.has('s1'), false, 'the answer is dropped so the next turn probes afresh');
});

test('leaving the nested shell lets the next attempt install the hook', async () => {
  const h = harness({ hostIdentity: 'abc123|mac|boot-7' });
  h.mod.injectShellHook('s1');
  await h.settle();
  latestMarker(h)[1](h.mod.FOREIGN_CODE);

  h.mod.injectShellHook('s1'); // e.g. the next agent turn
  await h.settle();

  assert.deepEqual(
    h.probeCalls,
    ['ssh_host_identity:s1', 'ssh_host_identity:s1'],
    'the dropped answer means a fresh probe — a spurious mismatch costs one probe, not the guard',
  );
  assert.equal(h.inputs.length, 2, 'and a fresh attempt goes out');

  const [, again] = latestMarker(h);
  again(1);
  assert.equal(h.mt.shellState.hookInjected, true, 'which lands once the prompt on screen is really ours');
});

// ── §6: the line is *typed into a shell*, so that shell's parser gets a vote ─
//
// Everything above drives the machinery with a stubbed terminal: the command is
// built and then asserted as text. That is precisely the gap the host-identity
// guard fell into. `__meterm_id="$(…)"` is a bash assignment, and fish does not
// merely fail to *run* an unknown command — it parses the whole line before
// running any of it, so the line died before the first `printf`. The outcome was
// not a weaker guard but no feature at all: no 7766 marker (not even a 9), so
// the handshake timed out, the retry chain spent its budget on the same parse
// error, and every fish session ended hookless. The body had the same trap —
// `export HISTCONTROL="${HISTCONTROL:+…}"` sits in a branch fish never takes and
// still cost it the hook.
//
// Reading the generated string cannot catch that. So these tests hand it to the
// shells themselves: parsed in each, then run for real — on our own host, where
// the hook must land, and against a stranger's identity, where nothing may.
//
// `sh` is included for the parse check only: no MeTerm hook targets it, and on
// macOS it *is* bash, so its branch code is not a portable thing to assert.

const SHELLS: Array<[string, string[]]> = [
  ['bash', ['bash', '/bin/bash']],
  ['zsh', ['zsh', '/bin/zsh']],
  ['sh', ['sh', '/bin/sh']],
  // Absent in CI, present when a developer has one — which is the only place
  // the fish branch can be exercised at all.
  ['fish', ['fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/opt/local/bin/fish']],
];

/** The shell's binary, or null when this machine does not have it. */
function availableShell(candidates: string[]): string | null {
  for (const bin of candidates) {
    const probe = spawnSync(bin, ['-c', 'exit 0'], { stdio: 'pipe' });
    if (!probe.error && probe.status === 0) return bin;
  }
  return null;
}

/** Parse-only check: the shell's complaint, or null when the line is well-formed. */
function syntaxComplaint(shell: string, script: string): string | null {
  const file = join(mkdtempSync(join(tmpdir(), 'meterm-inject-')), 'line');
  writeFileSync(file, script);
  const parsed = spawnSync(shell, ['-n', file], { encoding: 'utf8', stdio: 'pipe' });
  if (parsed.status === 0) return null;
  return `${parsed.stderr ?? ''}`.replace(/\s+/g, ' ').trim();
}

/** The command the injection would type, exactly as `sendInput` receives it. */
async function generatedCommand(hostIdentity: string | null): Promise<string> {
  const h = harness({ hostIdentity });
  h.mod.injectShellHook('s1');
  await h.settle();
  assert.equal(h.inputs.length, 1, 'the injection should have gone out');
  assert.equal(h.inputs[0][0], '\x15', 'and be prefixed with Ctrl-U');
  return h.inputs[0].slice(1);
}

/** Every `OSC 7766;id;code` the shell emitted, as the `code` field. */
function detectCodes(output: string): string[] {
  return [...output.matchAll(/\]7766;([^\x07]*)\x07/g)].map((match) => match[1].split(';').pop() ?? '');
}

const IDENTITY_EXPR = harness().mod.HOST_IDENTITY_EXPR;
const FOREIGN_CODE = harness().mod.FOREIGN_CODE;

test('the identity expression really produces a usable value on this machine', () => {
  // Not a tautology: the guard compares two computations of this expression, so
  // if it could not run here, "our host passes" below would be untestable.
  const shell = availableShell(['sh', '/bin/sh']);
  assert.ok(shell, 'these tests need a POSIX sh');
  const probe = spawnSync(shell, ['-c', `${IDENTITY_EXPR}; printf %s "$__meterm_id"`], { encoding: 'utf8' });
  assert.equal(probe.status, 0, `the expression must run under sh: ${probe.stderr}`);
  assert.ok((probe.stdout ?? '').length > 0, 'an empty identity would make every host look foreign');
});

test('the generated injection parses in every shell MeTerm supports', async () => {
  const scripts = {
    unguarded: await generatedCommand(null),
    guarded: await generatedCommand('abc123|mac|boot-7'),
  };

  for (const [name, candidates] of SHELLS) {
    const shell = availableShell(candidates);
    if (!shell) continue;
    for (const [kind, script] of Object.entries(scripts)) {
      assert.equal(
        syntaxComplaint(shell, script),
        null,
        `the ${kind} injection must parse in ${name}. A construct the foreground shell does not `
        + `know is not a degraded guard or a lost statistic — fish rejects the *entire line* before `
        + `running any of it, so the session gets nothing and the retry chain repeats it.`,
      );
    }
  }
});

/**
 * The end-to-end claim, in the shells that actually matter: identity checked, on
 * the shell that runs it, with the hook landing on one branch and nothing
 * landing on a stranger.
 *
 * The probe after the injection is not decoration — the 7766 detect marker is
 * emitted *before* the hook is `eval`ed, so a marker alone would also be
 * produced by a hook that failed to parse. Asking the shell whether the hook
 * function exists is what separates "installed" from "announced".
 */
test('the hook lands on our own host and never on a stranger', async () => {
  const ourIdentity = spawnSync(
    availableShell(['sh', '/bin/sh'])!,
    ['-c', `${IDENTITY_EXPR}; printf %s "$__meterm_id"`],
    { encoding: 'utf8' },
  ).stdout ?? '';

  const branch = {
    bash: { code: '0', probe: 'declare -F __meterm_precmd >/dev/null && echo LANDED || echo ABSENT' },
    zsh: { code: '1', probe: '(( $+functions[__meterm_precmd] )) && echo LANDED || echo ABSENT' },
    fish: { code: '2', probe: 'functions -q __meterm_postcmd; and echo LANDED; or echo ABSENT' },
  } as const;

  for (const [shellType, spec] of Object.entries(branch)) {
    const shell = availableShell(SHELLS.find(([name]) => name === shellType)![1]);
    if (!shell) continue;

    const accepted = spawnSync(shell, ['-c', `${await generatedCommand(ourIdentity)}\n${spec.probe}`], {
      encoding: 'utf8', timeout: 30_000,
    });
    const acceptedOut = `${accepted.stdout ?? ''}${accepted.stderr ?? ''}`;
    assert.match(acceptedOut, /LANDED/, `${shellType}: the hook has to install where the host matches`);
    assert.deepEqual(
      detectCodes(acceptedOut),
      [spec.code],
      `${shellType} must report its own branch code exactly once — a second marker would mean the `
      + `host check ran more than once per injection`,
    );
    assert.equal(
      (accepted.stderr ?? '').trim(), '',
      `${shellType} must not have to complain about anything on the way: ${accepted.stderr}`,
    );

    const refused = spawnSync(
      shell,
      ['-c', `${await generatedCommand('some-other-host|elsewhere|boot-0')}\n${spec.probe}`],
      { encoding: 'utf8', timeout: 30_000 },
    );
    const refusedOut = `${refused.stdout ?? ''}${refused.stderr ?? ''}`;
    assert.match(
      refusedOut, /ABSENT/,
      `${shellType}: a mismatch means the command has landed on a nested ssh's host, where installing `
      + `the hook is worse than staying hookless — this session would then be marked injected while `
      + `its cwd, exit codes and durations describe the other machine`,
    );
    assert.deepEqual(
      detectCodes(refusedOut),
      [String(FOREIGN_CODE)],
      `${shellType} must answer a mismatch with the foreign-host code and nothing else`,
    );
  }
});

/**
 * A line fish can finally parse also *runs* in fish for the first time ever, and
 * that is a change to somebody else's server. `HISTCONTROL` is read by bash and
 * zsh, means nothing to fish, and exporting it there would turn "make the hook
 * work in fish" into "make fish's environment different" — the sort of side
 * effect that is invisible until it isn't. Hence the `$BASH_VERSION$ZSH_VERSION`
 * gate, and hence a test that pins both sides of it.
 */
test('the history-control export reaches bash and zsh, but not fish', async () => {
  const cmd = await generatedCommand(null);

  const bash = availableShell(['bash', '/bin/bash']);
  if (bash) {
    const probed = spawnSync(bash, ['-c', `${cmd}\nprintf '<%s>' "$HISTCONTROL"`], { encoding: 'utf8' });
    assert.match(
      probed.stdout ?? '', /<[^>]*ignorespace>/,
      'the whole point of the export is that the injected line is kept out of bash history',
    );
  }

  const fish = availableShell(SHELLS.find(([name]) => name === 'fish')![1]);
  if (fish) {
    const probed = spawnSync(
      fish, ['-c', `${cmd}\nset -q HISTCONTROL; and echo LEAKED; or echo CLEAN`], { encoding: 'utf8' },
    );
    assert.match(
      probed.stdout ?? '', /CLEAN/,
      'fish has no HISTCONTROL to set — a variable that only bash and zsh read must not appear in a '
      + 'fish session\'s environment just because the line is finally able to run there',
    );
  }
});
