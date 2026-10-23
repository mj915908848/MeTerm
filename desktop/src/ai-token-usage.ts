// ─── AI Provider: Token Usage ───────────────────────────────────
// Reads the token counts providers report at the end of a stream into
// one shape, so a run can show what it actually cost, cache hits
// included. No imports, so `node --test` can load it directly.

export interface TokenUsage {
  /** Every input token of the request, cached ones included. */
  input: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedInput: number;
  /** Output tokens, reasoning included. */
  output: number;
  /** Number of model requests these counts add up. */
  requests: number;
}

function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * OpenAI-compatible `usage` (the last chunk of a stream). `prompt_tokens`
 * already counts cached tokens; OpenAI reports the hits under
 * `prompt_tokens_details.cached_tokens`, DeepSeek as `prompt_cache_hit_tokens`.
 */
export function openAIUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const input = n(u.prompt_tokens);
  const output = n(u.completion_tokens);
  if (!input && !output) return null;
  return {
    input,
    cachedInput: Math.min(input, n(details.cached_tokens) || n(u.prompt_cache_hit_tokens)),
    output,
    requests: 1,
  };
}

/**
 * Anthropic usage from `message_start` (input side) and the last
 * `message_delta` (output side). `input_tokens` excludes the tokens
 * written to or read from the cache, so they are added back.
 */
export function anthropicUsage(start: unknown, delta: unknown): TokenUsage | null {
  const s = (start && typeof start === 'object' ? start : {}) as Record<string, unknown>;
  const d = (delta && typeof delta === 'object' ? delta : {}) as Record<string, unknown>;
  const read = n(d.cache_read_input_tokens) || n(s.cache_read_input_tokens);
  const written = n(d.cache_creation_input_tokens) || n(s.cache_creation_input_tokens);
  const input = (n(d.input_tokens) || n(s.input_tokens)) + read + written;
  const output = n(d.output_tokens) || n(s.output_tokens);
  if (!input && !output) return null;
  return { input, cachedInput: read, output, requests: 1 };
}

/** Gemini `usageMetadata`; thinking tokens are billed as output. */
export function geminiUsage(meta: unknown): TokenUsage | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  const input = n(m.promptTokenCount);
  const output = n(m.candidatesTokenCount) + n(m.thoughtsTokenCount);
  if (!input && !output) return null;
  return { input, cachedInput: Math.min(input, n(m.cachedContentTokenCount)), output, requests: 1 };
}

export function addUsage(total: TokenUsage | null, more: TokenUsage | undefined | null): TokenUsage | null {
  if (!more) return total;
  if (!total) return { ...more };
  return {
    input: total.input + more.input,
    cachedInput: total.cachedInput + more.cachedInput,
    output: total.output + more.output,
    requests: total.requests + more.requests,
  };
}

function compact(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/** One line under the reply, e.g. "Tokens: 45.2K in (38.0K cached) · 1.2K out · 6 requests". */
export function formatUsage(u: TokenUsage, lang: 'zh' | 'en'): string {
  if (lang === 'zh') {
    const cached = u.cachedInput > 0 ? `（缓存命中 ${compact(u.cachedInput)}）` : '';
    return `Token：输入 ${compact(u.input)}${cached} · 输出 ${compact(u.output)} · ${u.requests} 次请求`;
  }
  const cached = u.cachedInput > 0 ? ` (${compact(u.cachedInput)} cached)` : '';
  const requests = `${u.requests} request${u.requests === 1 ? '' : 's'}`;
  return `Tokens: ${compact(u.input)} in${cached} · ${compact(u.output)} out · ${requests}`;
}
