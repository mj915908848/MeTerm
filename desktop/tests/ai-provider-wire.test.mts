import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { anthropicAcceptsTemperature, anthropicCacheLayout, parseToolArguments, sseData, streamPayloadError, TURN_CONTEXT_HEADING } from '../src/ai-provider-wire.ts';
import { classifyError } from '../src/ai-agent-errors.ts';

test('SSE data lines are read with or without a space after the colon', () => {
  assert.equal(sseData('data: {"a":1}'), '{"a":1}');
  assert.equal(sseData('data:{"a":1}\r'), '{"a":1}');
  assert.equal(sseData('event: ping'), null);
  assert.equal(sseData(''), null);
});

test('error events inside a 200 stream become classified provider errors', () => {
  const overloaded = streamPayloadError('anthropic', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  assert.ok(overloaded);
  assert.equal(classifyError(overloaded).category, 'server_error');
  const limited = streamPayloadError('anthropic', { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
  assert.equal(classifyError(limited!).category, 'rate_limit');
  assert.equal(streamPayloadError('anthropic', { type: 'content_block_delta', delta: {} }), null);

  const gemini = streamPayloadError('gemini', { error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } });
  assert.equal(classifyError(gemini!).category, 'rate_limit');
  const openai = streamPayloadError('openai', { error: { message: 'The server had an error', type: 'server_error' } });
  assert.equal(classifyError(openai!).category, 'server_error');
  assert.equal(streamPayloadError('openai', { choices: [], error: null }), null);
});

test('tool arguments that are not a JSON object are rejected, empty means none', () => {
  assert.deepEqual(parseToolArguments(''), { ok: true, args: {} });
  assert.deepEqual(parseToolArguments('  '), { ok: true, args: {} });
  assert.deepEqual(parseToolArguments('{"command":"ls"}'), { ok: true, args: { command: 'ls' } });
  assert.equal(parseToolArguments('{"path":"/tmp/a","content":"cut of').ok, false);
  assert.equal(parseToolArguments('[1]').ok, false);
  assert.equal(parseToolArguments('null').ok, false);
});

test('a history error that names tool_use does not switch tools off', () => {
  const err = new Error('HTTP 400: messages.3: `tool_use` ids were found without `tool_result` blocks immediately after');
  assert.notEqual(classifyError(err).category, 'tool_unsupported');
  assert.equal(classifyError(new Error('HTTP 400: tool_use is not supported for this model')).category, 'tool_unsupported');
});

test('run_command passes the stop signal into its wait loop', () => {
  const source = readFileSync(new URL('../src/ai-tools-command.ts', import.meta.url), 'utf8');
  assert.match(source, /executeAgentCommand\(\s*pane\.sessionId, cmd, pane\.shellType, timeout, ctx\.abortSignal,\s*\)/);
});

test('anthropic cache layout keeps per-turn context out of the cached prefix', () => {
  const system = 'INSTRUCTIONS\n\nPANE OUTPUT';
  const stable = 'INSTRUCTIONS\n\n'.length;
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
  ];
  const out = anthropicCacheLayout(system, stable, messages);
  assert.deepEqual(out.system, [{ type: 'text', text: 'INSTRUCTIONS', cache_control: { type: 'ephemeral' } }]);
  const last = out.messages[2].content as any[];
  assert.deepEqual(last[0], { type: 'tool_result', tool_use_id: 't1', content: 'done', cache_control: { type: 'ephemeral' } });
  assert.equal(last[1].text, `${TURN_CONTEXT_HEADING}\n\nPANE OUTPUT`);
  assert.equal(last[1].cache_control, undefined);
  // The caller's messages are not mutated, so the next request's prefix matches.
  assert.equal((messages[2].content as any[])[0].cache_control, undefined);
  assert.equal(out.messages[0], messages[0]);
});

test('anthropic cache layout falls back to system blocks when it cannot split', () => {
  const whole = anthropicCacheLayout('ALL', undefined, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(whole.system, [{ type: 'text', text: 'ALL', cache_control: { type: 'ephemeral' } }]);
  const noUser = anthropicCacheLayout('A\nB', 2, [{ role: 'assistant', content: 'x' }]);
  assert.deepEqual(noUser.system, [
    { type: 'text', text: 'A', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'B' },
  ]);
  const user = anthropicCacheLayout('A\nB', 2, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(user.messages[0].content, [
    { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `${TURN_CONTEXT_HEADING}\n\nB` },
  ]);
});

test('temperature is only sent to Claude models that still accept it', () => {
  for (const m of ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022', 'claude-3-7-sonnet-latest', 'my-proxy-model']) {
    assert.equal(anthropicAcceptsTemperature(m), true, m);
  }
  for (const m of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5',
    'claude-haiku-5-5', 'claude-fable-5-1']) {
    assert.equal(anthropicAcceptsTemperature(m), false, m);
  }
});
