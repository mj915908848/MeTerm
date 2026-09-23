import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  EXIT_CODE_UNKNOWN,
  shouldCompleteFromPromptTail,
  userTypedRecently,
} from '../src/ai-terminal-watch-lifecycle.ts';

/**
 * `ai-tools-shell.ts` cannot be imported here (extensionless frontend graph),
 * so the wait loop is sliced out by declaration name and run against stubbed
 * PTY primitives — the same technique the watch tests use.
 */
function sourceOf(file: string, name: string): string {
  const path = new URL(`../src/${file}`, import.meta.url);
  const parsed = ts.createSourceFile(file, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return ts.transpile(statement.getText(parsed).replace('export ', ''), { target: ts.ScriptTarget.ES2021 });
    }
  }
  assert.fail(`${name} not found in ${file}`);
}

/** Same shape as the real predicate in ai-tools-prompt-detect.ts. */
const endsWithShellPromptStub = (buffer: string): boolean => {
  const lines = buffer.replace(/\r/g, '').split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1];
  if (!/[$#%>»]\s*$/.test(last)) return false;
  return !/password|passphrase|yes\/no|y\/n/i.test(last);
};

function waitHarness(overrides: {
  hookInjected?: boolean;
  lastExitCode?: number;
  lastUserInputAt?: number;
} = {}) {
  const outputs = new Set<(data: string) => void>();
  const idles = new Set<() => void>();
  const terminal = {
    terminal: { buffer: { active: { type: 'normal' } } },
    shellState: {
      lastExitCode: overrides.lastExitCode ?? 0,
      hookInjected: overrides.hookInjected ?? false,
      cwd: '/home/mj',
      lastUserInputAt: overrides.lastUserInputAt ?? 0,
    },
  };
  const registry = {
    get: () => terminal,
    onOutput: (_: string, fn: (data: string) => void) => { outputs.add(fn); return () => outputs.delete(fn); },
    onShellIdle: (_: string, fn: () => void) => { idles.add(fn); return () => idles.delete(fn); },
  };
  const exitCodeFromHook = () => (terminal.shellState.hookInjected
    ? terminal.shellState.lastExitCode
    : EXIT_CODE_UNKNOWN);
  const create = new Function(
    'TerminalRegistry', 'stripAnsi', 'detectInteractiveState', 'endsWithShellPrompt',
    'shouldCompleteFromPromptTail', 'userTypedRecently', 'exitCodeFromHook', 'EXIT_CODE_UNKNOWN',
    `${sourceOf('ai-tools-shell.ts', 'isAlternateScreen')}
     ${sourceOf('ai-tools-shell.ts', 'detectorToStatus')}
     ${sourceOf('ai-tools-shell.ts', 'runWaitLoop')}
     return runWaitLoop;`,
  );
  const runWaitLoop = create(
    registry, (s: string) => s, () => ({ state: 'active' }), endsWithShellPromptStub,
    shouldCompleteFromPromptTail, userTypedRecently, exitCodeFromHook, EXIT_CODE_UNKNOWN,
  ) as (
    sessionId: string,
    options: { timeoutSec: number; detectAfterSilenceMs: number; giveUpAfterSilenceMs: number },
    signal?: { aborted: boolean },
  ) => Promise<{ output: string; exitCode: number; cwd: string; status: string }>;

  return { runWaitLoop, outputs, idles, terminal };
}

/** Short windows so the loop's 300ms tick still exercises every branch. */
const fastOptions = { timeoutSec: 3, detectAfterSilenceMs: 20, giveUpAfterSilenceMs: 240 };
const PROMPT = 'user@host ~ % ';

test('hookless wait completes on a prompt tail but reports no exit code', async () => {
  // The bug this guards: the visual-completion branch returned
  // `lastExitCode`, which only the OSC 7768 handler ever writes — so on a
  // hookless session it returned the initial 0 and called every failed
  // command a success. Its own comment said it should return -1.
  const h = waitHarness({ hookInjected: false, lastExitCode: 0 });
  const pending = h.runWaitLoop('s1', fastOptions);
  for (const emit of h.outputs) emit(`README.md\n${PROMPT}`);

  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, EXIT_CODE_UNKNOWN);
  assert.match(result.output, /exit code unavailable: this session has no shell hook/);
  assert.equal(result.cwd, '/home/mj');
  assert.equal(h.outputs.size + h.idles.size, 0, 'no listener may be left behind');
});

test('a live shell hook outranks the prompt tail (no stale exit code)', async () => {
  // With the hook alive, onShellIdle is authoritative. Letting the visible
  // tail complete the wait would report the PREVIOUS command's exit code —
  // and a tail that merely looks like a prompt can be minutes old.
  const h = waitHarness({ hookInjected: true, lastExitCode: 7 });
  const pending = h.runWaitLoop('s1', fastOptions);
  for (const emit of h.outputs) emit(`README.md\n${PROMPT}`);

  const result = await pending;
  assert.equal(result.status, 'idle_no_signal', 'must not read the tail as a completion');
  assert.equal(result.exitCode, 7, 'the hook-reported code survives the give-up path');
});

test('the shell hook completing the wait reports its own exit code', async () => {
  const h = waitHarness({ hookInjected: true, lastExitCode: 130 });
  const pending = h.runWaitLoop('s1', { ...fastOptions, timeoutSec: 3 });
  for (const emit of h.outputs) emit('interrupted\n');
  for (const idle of h.idles) idle();

  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 130);
  assert.equal(h.outputs.size + h.idles.size, 0);
});

test('a prompt the user just produced is not evidence that the command finished', async () => {
  // Right after input the visible prompt is the OLD one, so the command it
  // was typed for may not have started yet.
  const h = waitHarness({ hookInjected: false, lastUserInputAt: Date.now() });
  const pending = h.runWaitLoop('s1', fastOptions);
  for (const emit of h.outputs) emit(`user@host ~ % ls\n${PROMPT}`);

  const result = await pending;
  assert.equal(result.status, 'idle_no_signal', 'must keep waiting instead of claiming completion');
  assert.equal(result.exitCode, EXIT_CODE_UNKNOWN);
});

test('a streaming command is never mistaken for a finished one', async () => {
  const h = waitHarness({ hookInjected: false });
  const pending = h.runWaitLoop('s1', { timeoutSec: 1, detectAfterSilenceMs: 100, giveUpAfterSilenceMs: 600 });
  const writer = setInterval(() => { for (const emit of h.outputs) emit('building...\n'); }, 40);
  try {
    const result = await pending;
    assert.equal(result.status, 'timeout', 'output still arriving is not a completion');
  } finally {
    clearInterval(writer);
  }
});
