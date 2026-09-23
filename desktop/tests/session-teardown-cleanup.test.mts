import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * Session teardown.
 *
 * Two teardown paths exist in `terminal.ts` (`detach()` for a session that
 * leaves this window, `destroy()` for a tab that closes) and they had already
 * drifted: `destroy()` cleared the liveness maps and the SSH dir probe,
 * `detach()` did not. Modules that keep their own per-session maps cannot clean
 * themselves up either — importing `terminal.ts`'s teardown from them would run
 * the dependency backwards into a cycle — so they register a disposer instead.
 *
 * `terminal.ts` cannot be imported here (it pulls in the extensionless frontend
 * graph), so the methods under test are sliced out of the class by name and run
 * against a fake registry. Their bodies only touch `this.<map>` plus the two
 * injected helpers, which is what makes that possible.
 */

const TERMINAL_SRC = readFileSync(new URL('../src/terminal.ts', import.meta.url), 'utf8');
const AI_SHELL_SRC = readFileSync(new URL('../src/ai-tools-shell.ts', import.meta.url), 'utf8');

/** Pull a class method's body out of `terminal.ts` as a standalone function. */
function loadMethod<T>(
  name: string,
  params: string[],
  /**
   * Free identifiers the body needs. They have to be bound in the scope the
   * function is *created* in, not passed at call time, so they are turned into
   * parameters of the wrapper.
   */
  scope: Record<string, unknown> = {},
): T {
  const parsed = ts.createSourceFile('terminal.ts', TERMINAL_SRC, ts.ScriptTarget.Latest, true);
  let body: string | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name?.getText(parsed) === name) {
      body = node.body?.getText(parsed) ?? null;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(body, `method ${name} not found in terminal.ts`);
  const js = ts.transpile(`return function ${name}(${params.join(', ')}) ${body}`, {
    target: ts.ScriptTarget.ES2021,
  });
  const names = Object.keys(scope);
  return new Function(...names, js)(...names.map((key) => scope[key])) as T;
}

/** Stand-in for a closed ManagedTerminal — only the members teardown touches. */
function fakeTerminal() {
  return {
    ended: false,
    reconnectTimer: null,
    resizeDebounce: null,
    settleTimers: [],
    _postResizeFilterTimer: null,
    observer: { disconnect: () => {} },
    ligaturesAddon: { dispose: () => {} },
    canvasAddon: { dispose: () => {} },
    webglAddon: { dispose: () => {} },
    transport: { close: () => {} },
    ws: { close: () => {} },
    _oscMarkerResolvers: new Map(),
    thumbnailTerminal: { dispose: () => {} },
    terminal: { dispose: () => {} },
    thumbnailContainer: { remove: () => {} },
    container: { remove: () => {} },
  };
}

/**
 * Build a fake registry `this` wired to the real teardown methods, plus the
 * per-session maps teardown is supposed to empty.
 */
function harness() {
  const disposed: string[] = [];
  const probed: string[] = [];

  const registry: Record<string, unknown> = {
    inputListeners: new Map([['s1', new Set([() => {}])]]),
    outputListeners: new Map([['s1', new Set([() => {}])]]),
    shellStateListeners: new Map([['s1', new Set([() => {}])]]),
    terminals: new Map([['s1', fakeTerminal()]]),
    resizeGeneration: new Map([['s1', 3]]),
    pingTimestamps: new Map([['s1', 111]]),
    lastPongTime: new Map([['s1', 222]]),
    lastInputPingTime: new Map([['s1', 333]]),
    sessionDisposers: new Set<(sessionId: string) => void>(),
  };

  const onSessionDisposed = loadMethod<(cb: (id: string) => void) => () => void>('onSessionDisposed', ['callback']);
  const notifySessionDisposed = loadMethod<(id: string) => void>('notifySessionDisposed', ['sessionId']);
  registry.notifySessionDisposed = notifySessionDisposed;
  registry.onSessionDisposed = onSessionDisposed;

  // Registering through the real method is what makes the registry observable.
  const register = (cb: (id: string) => void): (() => void) => onSessionDisposed.call(registry, cb);
  register((id) => disposed.push(id));

  // `clearSSHDirProbe` is imported by terminal.ts; supplying it is how the test
  // learns that teardown dropped the SSH dir probe.
  const scope = { clearSSHDirProbe: (sessionId: string) => { probed.push(sessionId); }, clearTimeout };
  const detach = loadMethod<(id: string) => void>('detach', ['sessionId'], scope);
  const destroy = loadMethod<(id: string) => void>('destroy', ['sessionId'], scope);

  return {
    registry,
    disposed,
    probed,
    register,
    detach,
    destroy,
    notify: (id: string) => notifySessionDisposed.call(registry, id),
    call: (method: (this: unknown, id: string) => void, id: string) => method.call(registry, id),
  };
}

const LIVENESS_MAPS = ['pingTimestamps', 'lastPongTime', 'lastInputPingTime'] as const;

for (const [label, pick] of [['destroy()', 'destroy'], ['detach()', 'detach']] as const) {
  test(`${label} drops every per-session entry it owns`, () => {
    const h = harness();
    const method = h[pick] as unknown as (this: unknown, id: string) => void;
    h.call(method, 's1');

    for (const key of LIVENESS_MAPS) {
      assert.equal(
        (h.registry[key] as Map<string, number>).has('s1'),
        false,
        `${label} must clear ${key} — both teardown paths used to differ here`,
      );
    }
    assert.deepEqual(h.probed, ['s1'], `${label} must drop the SSH dir probe`);
    assert.deepEqual(h.disposed, ['s1'], `${label} must tell registered disposers the session is gone`);
    assert.equal((h.registry.terminals as Map<string, unknown>).has('s1'), false);
  });
}

test('a disposer that throws cannot abort teardown or block the others', () => {
  const h = harness();
  const seen: string[] = [];
  h.register(() => { throw new Error('disposer blew up'); });
  h.register((id) => seen.push(id));

  h.notify('s1');

  assert.deepEqual(seen, ['s1'], 'the second disposer must still run');
});

test('onSessionDisposed returns a working unsubscribe', () => {
  const h = harness();
  const seen: string[] = [];
  const off = h.register((id) => seen.push(id));
  off();
  h.notify('s1');
  assert.deepEqual(seen, [], 'an unsubscribed disposer must not be called');
});

// ── the disposers registered by the modules that own the maps ─────

/**
 * Slice `ai-tools-shell.ts`'s registration (the module owns `sessionPtyTails`
 * and the retry bookkeeping) and run it with both collaborators injected, so
 * the assertion is on the real callback body rather than on a copy of it.
 */
function loadAiShellDisposer() {
  const at = AI_SHELL_SRC.indexOf('TerminalRegistry.onSessionDisposed(');
  assert.ok(at > 0, 'ai-tools-shell.ts must register a session disposer');
  const end = AI_SHELL_SRC.indexOf('});', at);
  assert.ok(end > at, 'the registration block must be terminated by `});`');
  const block = AI_SHELL_SRC.slice(at, end + 3);

  const registered: Array<(sessionId: string) => void> = [];
  const sessionPtyTails = new Map<string, unknown>([['s1', Promise.resolve()]]);
  const hostIdentity = new Map<string, unknown>([['s1', { status: 'known', value: 'abc' }]]);
  const cleared: string[] = [];

  new Function('TerminalRegistry', 'sessionPtyTails', 'clearHookRetry', '_hostIdentity', block)(
    { onSessionDisposed: (cb: (sessionId: string) => void) => { registered.push(cb); } },
    sessionPtyTails,
    (sessionId: string) => { cleared.push(sessionId); },
    hostIdentity,
  );

  assert.equal(registered.length, 1, 'exactly one disposer is expected');
  return { disposer: registered[0], sessionPtyTails, hostIdentity, cleared };
}

test('session teardown clears the PTY serialization tail', () => {
  const { disposer, sessionPtyTails } = loadAiShellDisposer();
  assert.equal(sessionPtyTails.has('s1'), true, 'precondition: the map holds the session');

  disposer('s1');

  assert.equal(
    sessionPtyTails.has('s1'),
    false,
    'the tail promise must go — nothing can be in flight for a dead session, and it pins its closure chain',
  );
});

test('session teardown also cancels the pending hook-retry timer', () => {
  const { disposer, cleared, hostIdentity } = loadAiShellDisposer();
  disposer('s1');
  assert.deepEqual(
    cleared,
    ['s1'],
    'must go through clearHookRetry so the queued timer is cancelled, not just the record dropped',
  );
  assert.equal(
    hostIdentity.has('s1'),
    false,
    'the host identity belongs to the connection, so a dead session must not keep its answer — '
    + 'and a surviving entry would be a stale guard for whatever session id gets reused next',
  );
});

test('the shell-type cache is released with the session', () => {
  // Keys are session ids, and the map never had a delete — one entry per
  // session the window had ever opened.
  const core = readFileSync(new URL('../src/ai-tools-core.ts', import.meta.url), 'utf8');
  const at = core.indexOf('TerminalRegistry.onSessionDisposed(');
  assert.ok(at > 0, 'ai-tools-core.ts must register a disposer for shellTypeCache');
  const block = core.slice(at, core.indexOf('});', at) + 3);

  const cache = new Map<string, string>([['s1', 'zsh']]);
  const registered: Array<(id: string) => void> = [];
  new Function('TerminalRegistry', 'shellTypeCache', block)(
    { onSessionDisposed: (cb: (id: string) => void) => { registered.push(cb); } },
    cache,
  );
  assert.equal(registered.length, 1, 'exactly one disposer is expected');
  registered[0]('s1');
  assert.equal(cache.size, 0, 'shellTypeCache must drop the session entry');
  assert.equal(cache.has('s1'), false);
});

// ── §3.2: the dead half of the shell state machine stays gone ─────

/**
 * `phase` is hook-only state (see ShellPhase in terminal-types.ts). It used to
 * carry a `user_active` transition and a `lastInputSource` tag that nothing
 * ever read, plus an `agentCommandSeq` counter with no reader at all — state
 * that made a code review believe the hookless phase mattered to completion
 * decisions. `watchForUserInput` was the one consumer of that belief, and it
 * had no call site.
 *
 * These assertions are deliberately about absence: re-adding a write-only state
 * is how the confusion started, and it would be invisible to every other test.
 */
const SRC_FILES = [
  'terminal.ts',
  'terminal-types.ts',
  'terminal-osc.ts',
  'terminal-click-move.ts',
  'ai-tools-core.ts',
  'ai-tools-shell.ts',
  'ai-tools-command.ts',
  'ai-tools.ts',
  'ai-terminal-watch-lifecycle.ts',
  'ai-empty-state.ts',
] as const;

const ALL_SRC = SRC_FILES.map((file) => [file, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')] as const);

/**
 * Does `source` actually *reference* `name` — as an identifier or as a string
 * literal (the union-member form, `phase = 'user_active'`)?
 *
 * Parsing rather than substring-matching on purpose: the comments left behind
 * by this cleanup explain why these names are gone, and a comment is not a
 * reference. `terminal-types.ts` would otherwise fail its own guard.
 */
function referencesSymbol(file: string, source: string, name: string): boolean {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) { found = true; return; }
    if (ts.isStringLiteralLike(node) && node.text === name) { found = true; return; }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return found;
}

test('no write-only shell-state fields survive', () => {
  for (const gone of ['user_active', 'lastInputSource', 'agentCommandSeq']) {
    for (const [file, source] of ALL_SRC) {
      assert.equal(
        referencesSymbol(file, source, gone),
        false,
        `${file} still references \`${gone}\` — it had no reader, so it can only mislead. `
        + `See the ShellPhase note in terminal-types.ts.`,
      );
    }
  }
});

test('the removed keyboard watcher stays removed', () => {
  for (const [file, source] of ALL_SRC) {
    assert.equal(
      referencesSymbol(file, source, 'watchForUserInput'),
      false,
      `${file} still references watchForUserInput`,
    );
  }
});

test('the phase union has exactly one definition', () => {
  const definitions = ALL_SRC.filter(([, source]) => /export type ShellPhase\s*=/.test(source)).map(([file]) => file);
  assert.deepEqual(definitions, ['terminal-types.ts'], 'ShellPhase must be declared once and imported elsewhere');
  assert.ok(
    ALL_SRC.find(([file]) => file === 'terminal-types.ts')![1].includes('export type ShellPhase'),
    'terminal-types.ts owns the phase union',
  );
});

test('readers of the hook-only phase are gated on the hook', () => {
  // The two places that used to read `phase` on a session where it can be
  // stale. Both must consult the prompt on screen / the hook flag instead.
  const command = ALL_SRC.find(([file]) => file === 'ai-tools-command.ts')![1];
  assert.ok(
    command.includes('if (!hookInjected || phase !== \'ready\') {'),
    'watch_terminal must not skip the on-screen prompt check on a hookless session',
  );
  assert.ok(
    command.includes('mt.shellState.hookInjected && mt.shellState.phase === \'ready\''),
    'wait_for_user_input must not treat a stale phase as evidence of a shell hook',
  );
});
