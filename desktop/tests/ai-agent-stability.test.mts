import assert from 'node:assert/strict';
import test from 'node:test';
import { createWatchLifecycle, WATCH_BUFFER_LIMIT, watchTimeoutSeconds } from '../src/ai-terminal-watch-lifecycle.ts';
import { buildTaskRetention, isTaskRetention } from '../src/ai-agent-retention.ts';
import type { ChatMessage } from '../src/ai-provider.ts';
import { trimHistory, compressContext } from '../src/ai-agent-history.ts';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * Extract one exported factory from a source file by AST name.
 *
 * The factory cannot be imported directly: `ai-tools-command.ts` pulls in the
 * whole extensionless frontend graph, which Node's ESM resolver cannot load.
 * Locating it by declaration name (instead of by nearby comment text) keeps the
 * harness working when comments or statement order change.
 */
function extractFactory(file: string, name: string): string {
  const path = new URL(`../src/${file}`, import.meta.url);
  const source = readFileSync(path, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const factory = parsed.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(factory, `factory ${name} not found in ${file}`);
  return factory.getText(parsed).replace('export ', '');
}

// Exercise the real tool factory with isolated terminal/PTY dependencies,
// without booting the desktop UI or a remote shell.
function watchHarness() {
  const js = ts.transpile(extractFactory('ai-tools-command.ts', 'createWatchTerminalTool'), { target: ts.ScriptTarget.ES2021 });
  const outputs = new Set<(data: string) => void>();
  const idles = new Set<() => void>();
  let locked = false;
  const terminal = { transport: { connected: true }, terminal: { buffer: { active: { type: 'normal' } } }, shellState: { lastExitCode: 0 } };
  const registry = {
    get: () => terminal,
    onOutput: (_: string, fn: (data: string) => void) => { outputs.add(fn); return () => outputs.delete(fn); },
    onShellIdle: (_: string, fn: () => void) => { idles.add(fn); return () => idles.delete(fn); },
  };
  // The factory's module-level collaborators are not part of the extraction.
  const create = new Function('TerminalRegistry', 'resolvePaneTarget', 'paneHeaderFor', 'PANE_PARAM_SCHEMA', 'withSessionPtyLock', 'stripAnsi', 'truncateOutput', 'TOKEN_BUDGET', 'detectInteractiveState', 'createWatchLifecycle', 'watchTimeoutSeconds', js + '\nreturn createWatchTerminalTool();');
  const tool = create(registry, () => ({ ok: true, pane: { sessionId: 'test' } }), () => '', {},
    async (_: string, fn: () => Promise<string>) => { locked = true; try { return await fn(); } finally { locked = false; } },
    (s: string) => s, (s: string) => s, { perToolOutputChars: 100000 },
    () => ({ state: 'none' }), createWatchLifecycle, watchTimeoutSeconds);
  return { tool, outputs, idles, get locked() { return locked; } };
}

test('real watch releases output/idle listeners and PTY lock on cancellation', async () => {
  const h = watchHarness(); const ctl = new AbortController();
  const result = h.tool.execute({}, { abortSignal: ctl.signal });
  assert.ok(h.locked); ctl.abort();
  assert.match(await result, /status: aborted/);
  assert.equal(h.outputs.size + h.idles.size, 0); assert.equal(h.locked, false);
});
test('real watch preserves pattern and shell completion behavior', async () => {
  for (const pattern of [true, false]) {
    const h = watchHarness();
    const result = h.tool.execute(pattern ? { pattern: 'READY' } : {}, {});
    for (const callback of h.outputs) callback('READY\n');
    if (!pattern) for (const callback of h.idles) callback();
    assert.match(await result, pattern ? /status: pattern_matched/ : /status: completed.*exit: 0/);
    assert.equal(h.outputs.size + h.idles.size, 0); assert.equal(h.locked, false);
  }
});
test('real continuous-log watch times out without interrupting simulated producer', async () => {
  const h = watchHarness(); let produced = 0;
  const writer = setInterval(() => { produced++; for (const fn of h.outputs) fn('log\n'); }, 5);
  try {
    const result = await h.tool.execute({ timeout: 3 }, {});
    assert.match(result, /status: timeout/);
    assert.equal(h.outputs.size + h.idles.size, 0); assert.equal(h.locked, false);
    const before = produced;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(produced > before);
  } finally { clearInterval(writer); }
});
test('real watch retains silence return behavior', async () => {
  const h = watchHarness();
  assert.match(await h.tool.execute({ idle_timeout: 3 }, {}), /status: idle_no_signal/);
  assert.equal(h.outputs.size + h.idles.size, 0); assert.equal(h.locked, false);
});

test('actual fallback and hard trim retain task state and complete tool pairs', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'Do not restart server A' }];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'assistant', content: '', tool_calls: [
      { id: `c${i}`, type: 'function', function: { name: 'read_terminal', arguments: '{}' } },
    ] }, { role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(4000) });
  }
  messages.push({ role: 'user', content: 'Only diagnose; no writes' });
  trimHistory(messages);
  assert.ok(isTaskRetention(messages[0]));
  assert.ok((messages[0].content as string).includes('Do not restart'));
  for (let i = 0; i < 3; i++) compressContext(messages);
  assert.equal(messages.filter(isTaskRetention).length, 1);
  assert.ok((messages[0].content as string).includes('Only diagnose; no writes'));
  for (const message of messages) {
    if (message.role === 'tool') assert.ok(messages.some(m => m.tool_calls?.some(tc => tc.id === message.tool_call_id)));
    for (const call of message.tool_calls ?? []) assert.ok(messages.some(m => m.role === 'tool' && m.tool_call_id === call.id));
  }
});

test('watch timeout defaults and bounds', () => {
  assert.equal(watchTimeoutSeconds(undefined), 60);
  assert.equal(watchTimeoutSeconds(NaN), 60);
  assert.equal(watchTimeoutSeconds(0), 3);
  assert.equal(watchTimeoutSeconds(999), 300);
});
test('watch cancellation disposes deadline and abort listener', async () => {
  const controller = new AbortController();
  const reasons: string[] = [];
  const lifecycle = createWatchLifecycle(controller.signal, 10, reason => {
    reasons.push(reason); lifecycle.dispose();
  });
  lifecycle.start();
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(reasons, ['aborted']);
});
test('already aborted watch returns immediately', () => {
  const controller = new AbortController(); controller.abort();
  let result = '';
  const lifecycle = createWatchLifecycle(controller.signal, 1000, reason => {
    result = reason; lifecycle.dispose();
  });
  lifecycle.start();
  assert.equal(result, 'aborted');
});
test('continuous simulated logs cannot extend total deadline', async () => {
  let lifecycle: ReturnType<typeof createWatchLifecycle>;
  const result = new Promise<string>(resolve => {
    lifecycle = createWatchLifecycle(undefined, 20, reason => { lifecycle.dispose(); resolve(reason); });
  });
  const writer = setInterval(() => lifecycle.append('log\n'), 1);
  try { assert.equal(await result, 'timeout'); } finally { clearInterval(writer); }
});
test('bounded logs retain latest output and indicate omission', () => {
  const lifecycle = createWatchLifecycle(undefined, 1000, () => {});
  lifecycle.append('x'.repeat(WATCH_BUFFER_LIMIT + 10));
  lifecycle.append('FINAL');
  assert.equal(lifecycle.output.length, WATCH_BUFFER_LIMIT);
  assert.ok(lifecycle.output.endsWith('FINAL'));
  assert.ok(lifecycle.wasTruncated);
  lifecycle.dispose();
  lifecycle.append('ignored');
  assert.ok(lifecycle.output.endsWith('FINAL'));
});
test('normal finish disposal prevents subsequent timeout or abort', async () => {
  const controller = new AbortController();
  const lifecycle = createWatchLifecycle(controller.signal, 10, () => assert.fail('callback after disposal'));
  lifecycle.dispose(); controller.abort();
  await new Promise(resolve => setTimeout(resolve, 20));
});
test('repeated task retention preserves original, summary and latest restrictions without nesting', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Diagnose server A; do not restart' },
    { role: 'user', content: '[Previous conversation summary — older turns]\nVerified: read only' },
    { role: 'user', content: 'Wait for approval before writes' },
  ];
  const first = buildTaskRetention(messages)!;
  const second = buildTaskRetention([first, { role: 'user', content: 'Server B is out of scope' }])!;
  assert.ok(isTaskRetention(second));
  for (const text of ['Diagnose server A', 'Verified: read only', 'Wait for approval', 'Server B is out of scope']) {
    assert.ok((second.content as string).includes(text));
  }
  assert.equal((second.content as string).split('Local task retention').length, 2);
});
test('retention has a strict total budget and preserves head and tail of oversized fields', () => {
  const record = buildTaskRetention([
    { role: 'user', content: 'ORIGINAL HEAD' + 'x'.repeat(9000) + 'ORIGINAL TAIL' },
    { role: 'user', content: '[Previous conversation summary' + 'y'.repeat(9000) + 'SUMMARY TAIL' },
    { role: 'user', content: 'LATEST HEAD' + 'z'.repeat(9000) + 'LATEST TAIL' },
  ])!;
  const text = record.content as string;
  assert.ok(text.length <= 6000);
  for (const value of ['ORIGINAL HEAD', 'ORIGINAL TAIL', 'SUMMARY TAIL', 'LATEST HEAD', 'LATEST TAIL', '[...omitted...]']) assert.ok(text.includes(value));
  assert.equal(buildTaskRetention([]), null);
});
