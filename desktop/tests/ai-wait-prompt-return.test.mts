// ─── AI Agent: hookless completion fallback for the wait cards ──
//
// Regression target: on an SSH session without the shell hook (OSC 7768
// never fires) the user typed the sudo password, the command finished
// and the shell printed its prompt again — but wait_for_user_input /
// the pre-emptive wait card only listened for shell idle, so the agent
// stayed blocked ("已收到你的输入，等待命令执行完成") until the timeout.
//
// Covered here:
//   • the fallback detector itself (real ai-tools-prompt-detect through
//     a sandbox, controllable clock/timers),
//   • the real startPreWait() body (AST slice + new Function) driven by
//     the real watcher, asserting the card's end event is dispatched,
//   • the wiring contract in ai-tools-command.ts (both wait paths must
//     use the fallback and must tear it down).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const SRC = (file: string) => new URL(`../src/${file}`, import.meta.url);

function readSrc(file: string): string {
  return readFileSync(SRC(file), 'utf8');
}

function transpile(file: string): string {
  return ts.transpileModule(readSrc(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
}

/** AST-extract a top-level function declaration (export stripped). */
function fnSource(file: string, name: string): string {
  const ast = ts.createSourceFile(file, readSrc(file), ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  assert.ok(node, `${file} no longer declares ${name}()`);
  return node!.getText().replace(/^export\s+/, '');
}

/** Load a src module inside a sandbox; require() throws on unmocked imports. */
function loadModule(file: string, mocks: Record<string, unknown>, globals: Record<string, unknown>) {
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(transpile(file), {
    exports,
    module: { exports },
    require: (spec: string) => {
      if (!(spec in mocks)) throw new Error(`unexpected import ${spec} from ${file}`);
      return mocks[spec];
    },
    ...globals,
  });
  return exports as any;
}

// ─── Controllable time + timers ─────────────────────────────────

class Clock {
  t = 1_700_000_000_000;
  now(): number { return this.t; }
  advance(ms: number): void { this.t += ms; }
}

function makeTimers() {
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  let seq = 0;
  return {
    intervals,
    timeouts,
    globals: {
      setInterval: (fn: () => void) => { const id = ++seq; intervals.set(id, fn); return id; },
      clearInterval: (id: number) => { intervals.delete(id); },
      setTimeout: (fn: () => void) => { const id = ++seq; timeouts.set(id, fn); return id; },
      clearTimeout: (id: number) => { timeouts.delete(id); },
    },
    /** One 300ms poll cycle. */
    tick(times = 1) {
      for (let i = 0; i < times; i++) {
        for (const fn of [...intervals.values()]) fn();
      }
    },
  };
}

// ─── Fake terminal session ──────────────────────────────────────

const PROMPT = 'miao@MHome:~$ ';
const PASSWORD_PROMPT = '[sudo] password for miao: ';

function makeSession() {
  let buffer = '';
  const outputListeners = new Set<(data: string) => void>();
  const inputListeners = new Set<(data: string) => void>();
  const registry = {
    onOutput: (_sid: string, cb: (data: string) => void) => {
      outputListeners.add(cb);
      return () => outputListeners.delete(cb);
    },
    onInput: (_sid: string, cb: (data: string) => void) => {
      inputListeners.add(cb);
      return () => inputListeners.delete(cb);
    },
    onShellIdle: (_sid: string, _cb: () => void) => () => {},
    serializeBuffer: (_sid: string) => buffer,
  };
  return {
    registry,
    /** Terminal prints data (and appends it to the serialized buffer). */
    write(data: string) {
      buffer += data;
      for (const cb of [...outputListeners]) cb(data);
    },
    /** Screen changes without going through the output stream. */
    setBuffer(value: string) { buffer = value; },
    /** The user pressed keys in the terminal. */
    fireInput(data = 'secret\r') {
      for (const cb of [...inputListeners]) cb(data);
    },
    outputListenerCount: () => outputListeners.size,
    inputListenerCount: () => inputListeners.size,
  };
}

/** The real prompt detector (sandboxed: it only needs stripAnsi). */
function loadPromptDetect() {
  // Real stripAnsi, lifted out of ai-tools-core.ts (which drags in
  // TerminalRegistry / TabManager / Drawer / Tauri APIs we do not need).
  const stripAnsi = new Function(
    `${ts.transpileModule(fnSource('ai-tools-core.ts', 'stripAnsi'), {
      compilerOptions: { target: ts.ScriptTarget.ES2021 },
    }).outputText}
     return stripAnsi;`,
  )() as (s: string) => string;

  return loadModule('ai-tools-prompt-detect.ts', { './ai-tools-core': { stripAnsi } }, {});
}

function loadFallback(session: ReturnType<typeof makeSession>, clock: Clock, timers: ReturnType<typeof makeTimers>) {
  return loadModule(
    'ai-wait-prompt-return.ts',
    {
      './terminal': { TerminalRegistry: session.registry },
      './ai-tools-prompt-detect': loadPromptDetect(),
    },
    {
      ...timers.globals,
      Date: { now: () => clock.now() },
      console,
    },
  );
}

// ─── The detector ───────────────────────────────────────────────

test('fallback: a returned prompt is recognized even with the stale sudo prompt in scrollback', () => {
  const clock = new Clock();
  const timers = makeTimers();
  const session = makeSession();
  const mod = loadFallback(session, clock, timers);

  // What the terminal ACTUALLY looks like after "sudo journalctl …" ran:
  // the password prompt line is still in scrollback, the shell prompt is
  // last. detectInteractiveState() reports waiting_password here (the
  // tail still says "password"), which is exactly why the wait cards must
  // not use it.
  session.setBuffer(`${PASSWORD_PROMPT}\nSep 20 00:08:11 MHome kernel: oops\n${PROMPT}`);
  assert.equal(mod.isShellPromptVisible('ssh-1'), true);

  // …while the password prompt itself is NOT a finished command.
  session.setBuffer(`${PROMPT}sudo journalctl -p err\n${PASSWORD_PROMPT}`);
  assert.equal(mod.isShellPromptVisible('ssh-1'), false);

  // Empty / missing session → never completes.
  session.setBuffer('');
  assert.equal(mod.isShellPromptVisible('ssh-1'), false);
});

// ─── The watcher ────────────────────────────────────────────────

test('fallback: prompt coming back after the password prompt completes the wait', () => {
  const clock = new Clock();
  const timers = makeTimers();
  const session = makeSession();
  const mod = loadFallback(session, clock, timers);

  let returns = 0;
  session.setBuffer(`${PROMPT}sudo journalctl -p err -n 40\n${PASSWORD_PROMPT}`);
  mod.watchForPromptReturn('ssh-1', () => false, () => { returns++; });

  // User types the password, sudo prints, the shell prompts again.
  session.write('\n');
  session.write('Sep 22 06:25:01 MHome kernel: Memory cgroup out of memory\n');
  session.write(PROMPT);

  clock.advance(300);
  timers.tick();                       // inside the arm grace period
  assert.equal(returns, 0);

  clock.advance(1500);                 // silence + prompt visible
  timers.tick();
  assert.equal(returns, 1, 'the wait must complete without any OSC 7768 signal');

  // Resolved once, and the output listener/timer are released.
  clock.advance(3000);
  timers.tick();
  assert.equal(returns, 1);
  assert.equal(session.outputListenerCount(), 0);
  assert.equal(timers.intervals.size, 0);
});

test('fallback: a prompt that was already up when the wait was armed never completes it', () => {
  const clock = new Clock();
  const timers = makeTimers();
  const session = makeSession();
  const mod = loadFallback(session, clock, timers);

  let typed = false;
  let returns = 0;
  session.setBuffer(`${PROMPT}`);
  mod.watchForPromptReturn('ssh-1', () => typed, () => { returns++; });

  clock.advance(10_000);
  timers.tick(20);
  assert.equal(returns, 0, 'no user input on a pre-existing prompt → keep waiting');

  // The user finally types (the wait card flips its input flag) and the
  // command returns to the prompt.
  typed = true;
  session.write('ls -l\n');
  clock.advance(300);
  timers.tick();
  assert.equal(returns, 0, 'still mid-command');

  session.write(PROMPT);
  clock.advance(300);
  timers.tick();
  assert.equal(returns, 0, 'prompt is back but the silence window has not elapsed yet');

  clock.advance(1500);
  timers.tick();
  assert.equal(returns, 1);
});

test('fallback: still-silent-but-not-finished states keep waiting', () => {
  const clock = new Clock();
  const timers = makeTimers();
  const session = makeSession();
  const mod = loadFallback(session, clock, timers);

  let returns = 0;
  session.setBuffer(`${PROMPT}sudo journalctl\n${PASSWORD_PROMPT}`);
  mod.watchForPromptReturn('ssh-1', () => true, () => { returns++; });

  // Terminal still shows the password prompt (wrong password → re-prompt,
  // or the command simply has not produced anything yet).
  clock.advance(5000);
  timers.tick(20);
  assert.equal(returns, 0);

  // The command started streaming: the prompt reappears but output keeps
  // arriving, so the silence window must hold us off.
  session.write(PROMPT);
  clock.advance(300);
  timers.tick();
  session.write('still printing\n');
  clock.advance(600);
  timers.tick();
  assert.equal(returns, 0, 'streaming output is not a finished command');

  session.write(PROMPT);
  clock.advance(2000);
  timers.tick();
  assert.equal(returns, 1);
});

test('fallback: cancel() drops the watcher silently', () => {
  const clock = new Clock();
  const timers = makeTimers();
  const session = makeSession();
  const mod = loadFallback(session, clock, timers);

  let returns = 0;
  session.setBuffer(`${PROMPT}sudo true\n${PASSWORD_PROMPT}`);
  const watch = mod.watchForPromptReturn('ssh-1', () => true, () => { returns++; });
  assert.equal(session.outputListenerCount(), 1);

  watch.cancel();
  assert.equal(session.outputListenerCount(), 0);
  assert.equal(timers.intervals.size, 0);

  session.setBuffer(`${PROMPT}`);
  clock.advance(10_000);
  timers.tick(20);
  assert.equal(returns, 0);
});

// ─── The real pre-emptive wait card ─────────────────────────────

class DocStub {
  dispatched: Array<{ type: string; detail: any }> = [];
  listeners: Record<string, Array<(e: any) => void>> = {};
  dispatchEvent(e: any): boolean {
    this.dispatched.push({ type: e.type, detail: e.detail });
    for (const fn of [...(this.listeners[e.type] ?? [])]) fn(e);
    return true;
  }
  addEventListener(type: string, fn: (e: any) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: (e: any) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  countOf(type: string, status?: string): number {
    return this.dispatched.filter((d) => d.type === type && (status === undefined || d.detail?.status === status)).length;
  }
}

class EvStub {
  type: string;
  detail: any;
  constructor(type: string, init?: { detail?: any }) {
    this.type = type;
    this.detail = init?.detail;
  }
}

/** Run the real startPreWait()/teardownPreWait() bodies over stubs. */
function loadPreWait(fallback: any, session: ReturnType<typeof makeSession>, doc: DocStub, timers: ReturnType<typeof makeTimers>) {
  const code = ts.transpileModule(
    [
      fnSource('ai-tools-command.ts', 'teardownPreWait'),
      fnSource('ai-tools-command.ts', 'startPreWait'),
    ].join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2021 } },
  ).outputText;

  return new Function(
    'TerminalRegistry', 'document', 'CustomEvent',
    'watchForPromptReturn', 'PRE_WAIT_HARD_TIMEOUT_MS', 'setTimeout', 'clearTimeout',
    `const activePreWaits = new Map();
     ${code}
     return { startPreWait, activePreWaits };`,
  )(
    session.registry,
    doc,
    EvStub,
    fallback.watchForPromptReturn,
    600_000,
    timers.globals.setTimeout,
    timers.globals.clearTimeout,
  ) as { startPreWait: (sid: string, reason: string) => string; activePreWaits: Map<string, unknown> };
}

test('pre-wait card: completing needs no shell hook (user types → prompt returns → card ends)', () => {
  const clock = new Clock();
  const timers = makeTimers();
  const session = makeSession();
  const fallback = loadFallback(session, clock, timers);
  const doc = new DocStub();
  const pre = loadPreWait(fallback, session, doc, timers);

  session.setBuffer(`${PROMPT}sudo journalctl -p err -n 40\n${PASSWORD_PROMPT}`);
  const cardId = pre.startPreWait('ssh-1', '自动检测到密码输入提示');
  assert.equal(doc.countOf('ai-pre-wait-mount'), 1);
  assert.equal(pre.activePreWaits.size, 1);

  // User types into the terminal → the card says "input received".
  session.fireInput();
  assert.equal(doc.countOf('ai-wait-for-user-input-received'), 1, 'typing must switch the card to "received"');

  // sudo finishes, the shell prompts again.
  session.write('Sep 22 06:25:01 MHome kernel: oom\n');
  session.write(PROMPT);

  clock.advance(1500);
  timers.tick();

  assert.equal(doc.countOf('ai-wait-for-user-input-end', 'completed'), 1, 'the card must resolve as completed');
  assert.equal(pre.activePreWaits.size, 0, 'the pre-wait must be torn down');
  assert.equal(session.outputListenerCount(), 0, 'no listener may be left behind');
});

test('pre-wait card: an abandoned prompt (no keystroke) is still released by a returned prompt', () => {
  const clock = new Clock();
  const timers = makeTimers();
  const session = makeSession();
  const fallback = loadFallback(session, clock, timers);
  const doc = new DocStub();
  const pre = loadPreWait(fallback, session, doc, timers);

  session.setBuffer(`${PROMPT}sudo journalctl -p err\n${PASSWORD_PROMPT}`);
  pre.startPreWait('ssh-1', '自动检测到密码输入提示');

  // Nobody typed: sudo gave up and the shell came back on its own.
  session.write('sudo: 3 incorrect password attempts\n');
  session.write(PROMPT);

  clock.advance(1500);
  timers.tick();

  assert.equal(doc.countOf('ai-wait-for-user-input-end', 'completed'), 1);
  assert.equal(pre.activePreWaits.size, 0);
});

// ─── Wiring contract ────────────────────────────────────────────

test('wiring: both wait paths use the hookless fallback and tear it down', () => {
  const src = readSrc('ai-tools-command.ts');

  assert.match(src, /from '\.\/ai-wait-prompt-return'/, 'ai-tools-command.ts must import the fallback');

  // Pre-emptive card: armed in startPreWait, cancelled in teardownPreWait.
  const teardown = fnSource('ai-tools-command.ts', 'teardownPreWait');
  assert.match(teardown, /promptWatch\?\.cancel\(\)/, 'teardownPreWait must cancel the fallback watcher');
  const preWait = fnSource('ai-tools-command.ts', 'startPreWait');
  assert.match(preWait, /watchForPromptReturn\(/, 'startPreWait must arm the fallback watcher');

  // wait_for_user_input: fast path + in-flight fallback.
  const waitTool = src.slice(src.indexOf('export function createWaitForUserInputTool()'));
  assert.ok(waitTool.length > 0, 'createWaitForUserInputTool must still exist');
  assert.match(
    waitTool,
    /mt\.shellState\.hookInjected && mt\.shellState\.phase === 'ready'/,
    'wait_for_user_input must recognize an already-returned prompt without the shell hook',
  );
  assert.match(
    waitTool,
    /hookAtPrompt \|\| isShellPromptVisible\(ctx\.sessionId\)/,
    'the screen-derived prompt check must remain reachable on a hookless session',
  );
  assert.match(waitTool, /promptWatch = watchForPromptReturn\(/, 'wait_for_user_input must arm the fallback watcher');
  assert.match(waitTool, /if \(promptWatch\) promptWatch\.cancel\(\);/, 'wait_for_user_input must cancel it in cleanup()');
});
