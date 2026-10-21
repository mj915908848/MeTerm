import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { anthropicAcceptsTemperature, anthropicCacheLayout, parseToolArguments, sseData, streamPayloadError, TURN_CONTEXT_HEADING, openAICompatParams, openAIRejectsTemperature } from '../src/ai-provider-wire.ts';
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

test('an output-limit 400 is not mistaken for context overflow', () => {
  for (const msg of [
    'HTTP 400: max_tokens: 200000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-4-6',
    'HTTP 400: max_tokens is too large: 200000. This model supports at most 16384 completion tokens, whereas you provided 200000.',
    'HTTP 400: Invalid value for maxOutputTokens: exceeds the supported range',
  ]) assert.notEqual(classifyError(new Error(msg)).category, 'context_overflow', msg);
  for (const msg of [
    "HTTP 400: This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
    'HTTP 400: prompt is too long: 210000 tokens > 200000 maximum',
    'HTTP 400: The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).',
    'HTTP 413: request too large',
  ]) assert.equal(classifyError(new Error(msg)).category, 'context_overflow', msg);
});

test('OpenAI-compatible params are shaped for the server they go to', () => {
  const thinking = { thinking: { type: 'enabled' }, enable_thinking: true, chat_template_kwargs: { enable_thinking: true } };
  const params = (baseUrl: string, model: string) =>
    openAICompatParams({ baseUrl, model, maxTokens: 4096, temperature: 0.2, thinkingFields: thinking });

  // Official OpenAI: no unknown fields, max_completion_tokens, and no
  // temperature for the reasoning families.
  assert.deepEqual(params('https://api.openai.com', 'gpt-4o'), { max_completion_tokens: 4096, temperature: 0.2 });
  assert.deepEqual(params('https://api.openai.com/', 'gpt-5.4'), { max_completion_tokens: 4096 });
  assert.deepEqual(params('https://api.openai.com', 'o4-mini'), { max_completion_tokens: 4096 });
  // Groq: strict about unknown fields too, but its models take temperature.
  assert.deepEqual(params('https://api.groq.com/openai', 'openai/gpt-oss-120b'), { max_completion_tokens: 4096, temperature: 0.2 });
  // Everyone else keeps exactly what was sent before.
  for (const base of ['http://localhost:11434', 'https://open.bigmodel.cn/api/paas/v4', 'https://api.deepseek.com', 'https://my-proxy.example/v1']) {
    assert.deepEqual(params(base, 'glm-4.5'), { max_tokens: 4096, temperature: 0.2, ...thinking }, base);
  }
});

test('only OpenAI reasoning model ids drop temperature', () => {
  for (const id of ['o1', 'o3-mini', 'o4-mini-2025-04-16', 'gpt-5', 'gpt-5-mini', 'gpt-5.4', 'gpt-6', 'openai/gpt-5']) {
    assert.equal(openAIRejectsTemperature(id), true, id);
  }
  for (const id of ['gpt-4o', 'gpt-4.1-mini', 'gpt-3.5-turbo', 'omni-moderation', 'gpt-50x-custom']) {
    assert.equal(openAIRejectsTemperature(id), false, id);
  }
});
