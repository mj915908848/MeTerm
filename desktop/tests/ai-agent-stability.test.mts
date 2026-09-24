import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWatchLifecycle,
  EXIT_CODE_UNKNOWN,
  exitCodeForReport,
  shouldCompleteFromPromptTail,
  userTypedRecently,
  WATCH_BUFFER_LIMIT,
  watchTimeoutSeconds,
  precheckWatch,
  lastMatchingLine,
  tailOf,
  WATCH_DETECT_SILENCE_MS,
  WATCH_DETECT_TAIL_CHARS,
  WATCH_PROMPT_SETTLE_MS,
  WATCH_RECENT_INPUT_GUARD_MS,
} from '../src/ai-terminal-watch-lifecycle.ts';
import { buildTaskRetention, isTaskRetention } from '../src/ai-agent-retention.ts';
import type { ChatMessage } from '../src/ai-provider.ts';
import { trimHistory, compressContext, shouldAutoCompact } from '../src/ai-agent-history.ts';
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

// Minimal stand-in for ai-tools-prompt-detect's endsWithShellPrompt. The harness
// cannot import that module (it pulls in the extensionless frontend graph), so
// the predicate is mirrored here with the same shape as the real one.
const endsWithShellPromptStub = (buffer: string): boolean => {
  const lines = buffer.replace(/\r/g, '').split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1];
  if (!/[$#%>»]\s*$/.test(last)) return false;
  return !/password|passphrase|密码|yes\/no|y\/n/i.test(last);
};

// Exercise the real tool factory with isolated terminal/PTY dependencies,
// without booting the desktop UI or a remote shell.
function watchHarness(overrides: {
  /** Serialized (already visible) screen content the fake terminal reports. */
  screen?: string;
  hookInjected?: boolean;
  phase?: string;
  /** Timestamp of the last keystroke/agent input, 0 = never. */
  lastUserInputAt?: number;
  /** Exit code the "shell hook" last reported. */
  lastExitCode?: number;
  detect?: () => { state: string; matchedLine?: string };
} = {}) {
  const js = ts.transpile(extractFactory('ai-tools-command.ts', 'createWatchTerminalTool'), { target: ts.ScriptTarget.ES2021 });
  const outputs = new Set<(data: string) => void>();
  const idles = new Set<() => void>();
  let locked = false;
  const screen = overrides.screen ?? '';
  const terminal = {
    transport: { connected: true },
    terminal: { buffer: { active: { type: 'normal' } } },
    shellState: {
      lastExitCode: overrides.lastExitCode ?? 0,
      hookInjected: overrides.hookInjected ?? false,
      phase: overrides.phase ?? 'unknown',
      lastUserInputAt: overrides.lastUserInputAt ?? 0,
    },
  };
  const registry = {
    get: () => terminal,
    serializeBuffer: () => screen,
    onOutput: (_: string, fn: (data: string) => void) => { outputs.add(fn); return () => outputs.delete(fn); },
    onShellIdle: (_: string, fn: () => void) => { idles.add(fn); return () => idles.delete(fn); },
  };
  // Mirrors ai-tools-core's exitCodeFromHook over the injected registry:
  // the exit code is only real while the shell hook is alive.
  const exitCodeFromHook = (sessionId: string) => exitCodeForReport(
    !!registry.get(sessionId)?.shellState.hookInjected,
    registry.get(sessionId)?.shellState.lastExitCode ?? EXIT_CODE_UNKNOWN,
  );
  // The factory's module-level collaborators are not part of the extraction.
  const create = new Function(
    'TerminalRegistry', 'resolvePaneTarget', 'paneHeaderFor', 'PANE_PARAM_SCHEMA',
    'withSessionPtyLock', 'stripAnsi', 'truncateOutput', 'TOKEN_BUDGET',
    'detectInteractiveState', 'endsWithShellPrompt', 'buildNextStepHint',
    'precheckWatch', 'lastMatchingLine', 'tailOf',
    'WATCH_DETECT_SILENCE_MS', 'WATCH_DETECT_TAIL_CHARS', 'WATCH_PROMPT_SETTLE_MS',
    'WATCH_RECENT_INPUT_GUARD_MS',
    'createWatchLifecycle', 'watchTimeoutSeconds',
    'shouldCompleteFromPromptTail', 'userTypedRecently', 'exitCodeFromHook', 'EXIT_CODE_UNKNOWN',
    js + '\nreturn createWatchTerminalTool();',
  );
  const tool = create(
    registry, () => ({ ok: true, pane: { sessionId: 'test' } }), () => '', {},
    async (_: string, fn: () => Promise<string>) => { locked = true; try { return await fn(); } finally { locked = false; } },
    (s: string) => s, (s: string) => s, { perToolOutputChars: 100000 },
    overrides.detect ?? (() => ({ state: 'active' })), endsWithShellPromptStub,
    (status: string) => `[hint ${status}]`,
    precheckWatch, lastMatchingLine, tailOf,
    WATCH_DETECT_SILENCE_MS, WATCH_DETECT_TAIL_CHARS, WATCH_PROMPT_SETTLE_MS,
    WATCH_RECENT_INPUT_GUARD_MS,
    createWatchLifecycle, watchTimeoutSeconds,
    shouldCompleteFromPromptTail, userTypedRecently, exitCodeFromHook, EXIT_CODE_UNKNOWN,
  );
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
    // hookInjected is a given for the idle-callback branch below: an OSC 7768
    // idle signal is emitted by the hook and by nothing else.
    const h = watchHarness({ hookInjected: !pattern });
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

test('live hookless watch completes after a newly arrived prompt settles', async () => {
  const h = watchHarness({ screen: 'command still running', lastExitCode: 0 });
  const result = h.tool.execute({ idle_timeout: 3 }, {});
  assert.ok(h.locked, 'the live watcher must be active before output arrives');
  const promptAt = Date.now();
  for (const callback of h.outputs) callback('command output\nuser@host ~ % ');
  const outcome = await result;
  assert.match(outcome, /status: completed, elapsed: [23]s, exit: -1/);
  assert.ok(Date.now() - promptAt >= WATCH_PROMPT_SETTLE_MS,
    'the prompt must remain quiet for the full settle interval before completion');
  assert.equal(h.outputs.size + h.idles.size, 0);
  assert.equal(h.locked, false);
});

// ─── watch_terminal: the "result is already there" fast path ─────────
// The watcher only ever waited for FUTURE events (OSC 7768 shell-idle, new
// output, the idle timeout, the deadline) and none of those are replayed. A
// command that finished BEFORE the watch began therefore made the caller sit
// out the whole idle timeout and then answer idle_no_signal with an empty
// body, even though the finished result was on screen the entire time.

test('watch precheck finishes at once on authoritative shell state', () => {
  const prompt = 'user@host ~ % ';
  assert.deepEqual(
    precheckWatch({ hookInjected: true, phase: 'ready', tail: prompt, pattern: null, tailIsPrompt: true }),
    { kind: 'completed', source: 'shell-hook' });
  // A foreground job still owns the PTY → must wait, prompt-looking tail or not.
  assert.deepEqual(
    precheckWatch({ hookInjected: true, phase: 'agent_executing', tail: prompt, pattern: null, tailIsPrompt: true }),
    { kind: 'proceed' });
  // No shell integration (SSH host without the hook) → the visible tail is
  // the only evidence available.
  assert.deepEqual(
    precheckWatch({ hookInjected: false, phase: 'unknown', tail: prompt, pattern: null, tailIsPrompt: true }),
    { kind: 'completed', source: 'prompt-tail' });
  assert.deepEqual(
    precheckWatch({ hookInjected: false, phase: 'unknown', tail: 'still building...', pattern: null, tailIsPrompt: false }),
    { kind: 'proceed' });
});

test('watch precheck lets an explicit pattern outrank shell state', () => {
  const tail = 'step 1\nBUILD SUCCESSFUL\nuser@host ~ %';
  assert.deepEqual(
    precheckWatch({ hookInjected: true, phase: 'ready', tail, pattern: /BUILD SUCCESSFUL/, tailIsPrompt: true }),
    { kind: 'pattern_matched', match: 'BUILD SUCCESSFUL' });
  assert.equal(lastMatchingLine(tail, /nope/), null);
  // A /g pattern must not resume mid-string on a second call.
  const global = /SUCCESSFUL/g;
  assert.equal(lastMatchingLine(tail, global), 'BUILD SUCCESSFUL');
  assert.equal(lastMatchingLine(tail, global), 'BUILD SUCCESSFUL');
});

test('tailOf keeps a line-aligned tail and passes short text through', () => {
  assert.equal(tailOf('short', 100), 'short');
  assert.equal(tailOf(`${'x'.repeat(50)}\nFINAL LINE\n`, 20), 'FINAL LINE\n');
});

test('watch returns at once when the command already finished', async () => {
  const h = watchHarness({ screen: 'README.md\nsrc\nuser@host ~ %', hookInjected: true, phase: 'ready' });
  const started = Date.now();
  const result = await h.tool.execute({}, {});
  assert.ok(Date.now() - started < 500, 'must not burn the idle timeout');
  assert.match(result, /status: completed, elapsed: 0s/);
  assert.ok(result.includes('README.md'), 'the current screen is returned as the body');
  assert.equal(h.outputs.size + h.idles.size, 0);
  assert.equal(h.locked, false, 'the fast path must not take the PTY lock');
});

test('watch returns at once when the awaited pattern is already on screen', async () => {
  const h = watchHarness({ screen: 'BUILD SUCCESSFUL in 12s\nuser@host ~ %' });
  const result = await h.tool.execute({ pattern: 'BUILD SUCCESSFUL' }, {});
  assert.match(result, /status: pattern_matched, elapsed: 0s/);
  assert.ok(result.includes('BUILD SUCCESSFUL in 12s'));
  assert.equal(h.locked, false);
});

test('watch reports a prompt that was already waiting instead of idling out', async () => {
  const h = watchHarness({
    screen: '[sudo] password for mj: ',
    detect: () => ({ state: 'waiting_password', matchedLine: '[sudo] password for mj:' }),
  });
  const result = await h.tool.execute({}, {});
  assert.match(result, /status: waiting_password, elapsed: 0s/);
  assert.equal(h.locked, false);
});

test('watch accepts a bare prompt as completion when no shell hook exists', async () => {
  const h = watchHarness({ screen: 'user@host ~ %', lastUserInputAt: 0 });
  const result = await h.tool.execute({}, {});
  assert.match(result, /status: completed, elapsed: 0s/);
  assert.ok(result.includes('no shell-integration hook is available'));
});

test('watch does not read the stale prompt as a finished command right after input', async () => {
  // Same screen as above, but input landed a moment ago: that prompt is the
  // OLD one and the command it was typed for may not have started yet.
  const h = watchHarness({ screen: 'user@host ~ %', lastUserInputAt: Date.now() });
  const result = await h.tool.execute({ idle_timeout: 3 }, {});
  assert.match(result, /status: idle_no_signal/, 'must still wait instead of claiming completion');
});

test('watch reports no exit code (not a fabricated 0) on a hookless completion', async () => {
  // shellState.lastExitCode has exactly one writer — the OSC 7768 handler —
  // so without a hook it still holds its initial 0. Reporting that as this
  // command's exit status claimed success for every failed command.
  const h = watchHarness({ screen: 'user@host ~ %', lastExitCode: 0 });
  const result = await h.tool.execute({}, {});
  assert.match(result, /status: completed, elapsed: 0s, exit: -1/);
  assert.match(result, /exit code unavailable \(no shell hook\)/);
});

test('watch reports the real exit code when the shell hook supplied it', async () => {
  const h = watchHarness({
    screen: 'user@host ~ %', hookInjected: true, phase: 'ready', lastExitCode: 7,
  });
  const result = await h.tool.execute({}, {});
  assert.match(result, /status: completed, elapsed: 0s, exit: 7/);
});

test('completion signals are single-sourced: prompt tail, fresh input, exit codes', () => {
  // Truth table for the rule shared by watch_terminal and run_command's wait
  // loop. A prompt-shaped tail may only end a wait when no hook can speak AND
  // nothing was typed just now.
  assert.equal(shouldCompleteFromPromptTail({ hookInjected: false, recentUserInput: false, tailIsPrompt: true }), true);
  assert.equal(shouldCompleteFromPromptTail({ hookInjected: true, recentUserInput: false, tailIsPrompt: true }), false);
  assert.equal(shouldCompleteFromPromptTail({ hookInjected: false, recentUserInput: true, tailIsPrompt: true }), false);
  assert.equal(shouldCompleteFromPromptTail({ hookInjected: false, recentUserInput: false, tailIsPrompt: false }), false);
  // Input inside the guard window still counts as "just typed"; 0 means never.
  assert.equal(userTypedRecently(1000, 1000 + WATCH_RECENT_INPUT_GUARD_MS - 1), true);
  assert.equal(userTypedRecently(1000, 1000 + WATCH_RECENT_INPUT_GUARD_MS), false);
  assert.equal(userTypedRecently(0, 5000), false);
  // An exit code survives the round trip only when the hook reported it.
  assert.equal(exitCodeForReport(true, 0), 0);
  assert.equal(exitCodeForReport(true, 130), 130);
  assert.equal(exitCodeForReport(false, 0), EXIT_CODE_UNKNOWN);
  assert.equal(exitCodeForReport(false, 130), EXIT_CODE_UNKNOWN);
});

test('watch without new output still returns the visible screen', async () => {
  const h = watchHarness({ screen: 'line one\nline two' });
  const result = await h.tool.execute({ idle_timeout: 3 }, {});
  assert.match(result, /status: idle_no_signal/);
  assert.ok(result.includes('line one'));
  assert.ok(result.includes('no new output during the watch window'));
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

// ─── shouldAutoCompact ──────────────────────────────────────────────
// The threshold used to be computed from two hardcoded numbers (a 128k
// window and a 4k output reservation), so the aiMaxTokens setting had no
// effect on when history got compressed. These pin the arithmetic and
// prove that BOTH inputs now move the threshold.

/** One message whose content is exactly `chars` characters long. */
const charsAsMessage = (chars: number): ChatMessage[] => [
  { role: 'user', content: 'x'.repeat(chars) },
];

test('shouldAutoCompact only fires once the estimate passes the threshold', () => {
  // budget = 10000 − 1000 − 2000 = 7000 → threshold = 5250 tokens
  assert.equal(shouldAutoCompact(charsAsMessage(20_000), 10_000, 1_000), false);
  assert.equal(shouldAutoCompact(charsAsMessage(22_000), 10_000, 1_000), true);
});

test('a larger history budget raises the threshold and delays compaction', () => {
  // 22000 chars ≈ 5500 tokens — over the small budget, under the large one.
  assert.equal(shouldAutoCompact(charsAsMessage(22_000), 10_000, 1_000), true);
  assert.equal(shouldAutoCompact(charsAsMessage(22_000), 20_000, 1_000), false);
});

test('a larger output reservation lowers the threshold and fires compaction earlier', () => {
  // This is the regression that made aiMaxTokens a no-op: the output
  // reservation is subtracted from the same budget, so raising
  // max_tokens must make compaction MORE eager, not less.
  assert.equal(shouldAutoCompact(charsAsMessage(10_000), 10_000, 1_000), false);
  assert.equal(shouldAutoCompact(charsAsMessage(10_000), 10_000, 6_000), true);
});

test('the default arguments reproduce the previously hardcoded threshold', () => {
  // floor((128000 − 4000 − 2000) × 0.75) = 91500 tokens = 366000 chars.
  // Pinned so that changing the defaults has to be a deliberate act.
  assert.equal(shouldAutoCompact(charsAsMessage(365_000)), false);
  assert.equal(shouldAutoCompact(charsAsMessage(367_000)), true);
});

test('the default history budget sits on the settings slider grid', () => {
  // Guards the trap that bit aiContextLines: a default below the slider
  // floor (or off its step grid) gets clamped by the <input type=range>,
  // and the control then displays a different number from the one used.
  const settings = readFileSync(
    new URL('../src/settings-ai.ts', import.meta.url),
    'utf8',
  );
  const slider = settings.match(
    /ai-history-budget-slider'\s*,\s*([0-9]+)\s*\*\s*1024\s*,\s*([0-9]+)\s*\*\s*1024\s*,\s*([0-9]+)\s*\*\s*1024/,
  );
  assert.ok(slider, 'ai-history-budget-slider row not found in settings-ai.ts — did it move?');
  const [min, max, step] = slider.slice(1, 4).map((n) => Number(n) * 1024);

  const themes = readFileSync(new URL('../src/themes.ts', import.meta.url), 'utf8');
  const def = themes.match(/aiHistoryBudgetTokens:\s*([0-9]+)\s*\*\s*1024/);
  assert.ok(def, 'aiHistoryBudgetTokens default not found in themes.ts — did it move?');
  const value = Number(def[1]) * 1024;

  assert.ok(
    value >= min && value <= max,
    `default ${value} is outside the slider range ${min}–${max}`,
  );
  assert.equal(
    (value - min) % step,
    0,
    `default ${value} does not land on the slider's ${step} step grid`,
  );
});
