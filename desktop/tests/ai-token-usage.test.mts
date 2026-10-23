import assert from 'node:assert/strict';
import test from 'node:test';
import { addUsage, anthropicUsage, formatUsage, geminiUsage, openAIUsage } from '../src/ai-token-usage.ts';

test('OpenAI-compatible usage reads cache hits from OpenAI and DeepSeek fields', () => {
  assert.deepEqual(
    openAIUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } }),
    { input: 1000, cachedInput: 800, output: 50, requests: 1 },
  );
  assert.deepEqual(
    openAIUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 360 }),
    { input: 1000, cachedInput: 640, output: 50, requests: 1 },
  );
  assert.equal(openAIUsage(null), null);
  assert.equal(openAIUsage({}), null);
});

test('Anthropic input adds back the tokens read from and written to the cache', () => {
  const u = anthropicUsage(
    { input_tokens: 20, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500, output_tokens: 1 },
    { output_tokens: 300 },
  );
  assert.deepEqual(u, { input: 9520, cachedInput: 9000, output: 300, requests: 1 });
  assert.equal(anthropicUsage(undefined, undefined), null);
});

test('Gemini output counts thinking tokens', () => {
  assert.deepEqual(
    geminiUsage({ promptTokenCount: 4000, cachedContentTokenCount: 3000, candidatesTokenCount: 100, thoughtsTokenCount: 400 }),
    { input: 4000, cachedInput: 3000, output: 500, requests: 1 },
  );
});

test('run totals add up and format compactly', () => {
  let total = addUsage(null, { input: 10_000, cachedInput: 8_000, output: 200, requests: 1 });
  total = addUsage(total, undefined);
  total = addUsage(total, { input: 12_500, cachedInput: 10_000, output: 1_000, requests: 1 });
  assert.deepEqual(total, { input: 22_500, cachedInput: 18_000, output: 1_200, requests: 2 });
  assert.equal(formatUsage(total!, 'en'), 'Tokens: 22.5K in (18.0K cached) · 1.2K out · 2 requests');
  assert.equal(formatUsage(total!, 'zh'), 'Token：输入 22.5K（缓存命中 18.0K） · 输出 1.2K · 2 次请求');
  assert.equal(formatUsage({ input: 900, cachedInput: 0, output: 5, requests: 1 }, 'en'), 'Tokens: 900 in · 5 out · 1 request');
});
