import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseToolArguments, sseData, streamPayloadError } from '../src/ai-provider-wire.ts';
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
