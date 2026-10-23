// ─── AI Provider: Wire-format Helpers ───────────────────────────
// Pure parsing of what providers send back (SSE lines, error events
// inside a 200 stream, tool-call argument JSON) and the Anthropic
// prompt-cache layout. No imports beyond types, so `node --test` can
// load it directly.

import type { ChatMessage, ProviderType } from './ai-provider';

/** The payload of an SSE `data:` line (the space after the colon is optional). */
export function sseData(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  return trimmed.slice(5).trimStart();
}

// HTTP status equivalents of the error types providers report inside a
// stream that already answered 200, so classifyError() can bucket them.
const ANTHROPIC_STREAM_ERROR_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};

/**
 * An error event inside an SSE stream (the HTTP status was already 200).
 * Returned in the broker's "HTTP <status>: <message>" shape so retry and
 * classification treat it like the same error before the stream began.
 */
export function streamPayloadError(type: ProviderType, parsed: unknown): Error | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as { type?: unknown; error?: unknown };
  const err = p.error && typeof p.error === 'object'
    ? p.error as { type?: unknown; code?: unknown; message?: unknown; status?: unknown }
    : null;
  let status: number;
  if (type === 'anthropic') {
    if (p.type !== 'error' || !err) return null;
    status = ANTHROPIC_STREAM_ERROR_STATUS[String(err.type)] ?? 500;
  } else {
    if (!err) return null;
    const code = Number(err.code);
    if (Number.isInteger(code) && code >= 400 && code < 600) status = code;
    else if (/rate|quota|exhausted/i.test(`${err.type ?? ''} ${err.code ?? ''} ${err.status ?? ''}`)) status = 429;
    else if (/invalid|bad_request/i.test(`${err.type ?? ''} ${err.code ?? ''} ${err.status ?? ''}`)) status = 400;
    else status = 500;
  }
  const message = typeof err.message === 'string' && err.message ? err.message : String(err.type ?? 'stream error');
  return new Error(`HTTP ${status}: ${message.slice(0, 300)} (reported during the stream)`);
}

/** Tool-call arguments as the model sent them; an empty string means none. */
export function parseToolArguments(
  raw: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || !raw.trim()) return { ok: true, args: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `Invalid tool arguments: not valid JSON (${(e as Error).message}).` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Invalid tool arguments: expected a JSON object.' };
  }
  return { ok: true, args: value as Record<string, unknown> };
}

const EPHEMERAL = { type: 'ephemeral' } as const;

/** Heading for the per-turn context when it is moved after the conversation. */
export const TURN_CONTEXT_HEADING = '[Current terminal context, refreshed every turn. Supplied by MeTerm, not typed by the user.]';

/**
 * Split the agent's system prompt at `stablePrefixChars` into the part that
 * is identical on every iteration and the per-turn context (terminal
 * output, plan, attachments). Null when there is nothing to split.
 */
export function splitTurnContext(
  systemText: string,
  stablePrefixChars: number | undefined,
): { stable: string; context: string } | null {
  if (stablePrefixChars === undefined || stablePrefixChars <= 0 || stablePrefixChars >= systemText.length) return null;
  return {
    stable: systemText.slice(0, stablePrefixChars).trimEnd(),
    context: systemText.slice(stablePrefixChars).trim(),
  };
}

/**
 * Lay out the system prompt and conversation for Anthropic prompt caching.
 *
 * Anthropic caches by exact prefix in the order tools → system → messages.
 * The agent's system prompt ends with terminal output that changes on every
 * iteration, so caching it whole meant every request rewrote the cache and
 * the conversation history was never cached at all.
 *
 * When `stablePrefixChars` marks where the unchanging part ends, only that
 * part stays in `system`. The rest is appended to the final user message,
 * after a cache breakpoint, so tools + instructions + history are a
 * prefix the next iteration can reuse.
 */
export function anthropicCacheLayout(
  systemText: string,
  stablePrefixChars: number | undefined,
  messages: Record<string, unknown>[],
): { system: unknown[]; messages: Record<string, unknown>[] } {
  const split = splitTurnContext(systemText, stablePrefixChars);
  if (!split) {
    return { system: [{ type: 'text', text: systemText, cache_control: EPHEMERAL }], messages };
  }
  const { stable, context } = split;
  const system: unknown[] = [{ type: 'text', text: stable, cache_control: EPHEMERAL }];
  if (!context) return { system, messages };

  const last = messages[messages.length - 1];
  const blocks = last?.role === 'user' ? userBlocks(last.content) : [];
  if (blocks.length === 0) {
    system.push({ type: 'text', text: context });
    return { system, messages };
  }
  blocks[blocks.length - 1] = { ...(blocks[blocks.length - 1] as object), cache_control: EPHEMERAL };
  blocks.push({ type: 'text', text: `${TURN_CONTEXT_HEADING}\n\n${context}` });
  return { system, messages: [...messages.slice(0, -1), { ...last, content: blocks }] };
}

/**
 * The same move for providers that cache prefixes on their own (DeepSeek,
 * OpenAI, Gemini, Qwen, GLM…): they match the request from the start, so
 * per-turn context inside the system message ended every cache hit before
 * the conversation history, which was then billed in full on every
 * iteration. The context is appended to the last user or tool message
 * instead, which keeps the role order every server accepts. When the
 * conversation does not end with one, the messages are returned unchanged.
 */
export function moveTurnContextToEnd(messages: ChatMessage[]): ChatMessage[] {
  const systemCount = messages.filter((m) => m.role === 'system').length;
  const sys = messages[0];
  const last = messages[messages.length - 1];
  if (systemCount !== 1 || sys?.role !== 'system' || typeof sys.content !== 'string') return messages;
  if (!last || (last.role !== 'user' && last.role !== 'tool')) return messages;
  const split = splitTurnContext(sys.content, sys.stablePrefixChars);
  if (!split) return messages;
  const system: ChatMessage = { ...sys, content: split.stable, stablePrefixChars: undefined };
  if (!split.context) return [system, ...messages.slice(1)];
  const text = `${TURN_CONTEXT_HEADING}\n\n${split.context}`;
  const content: ChatMessage['content'] = typeof last.content === 'string'
    ? (last.content ? `${last.content}\n\n${text}` : text)
    : [...last.content, { type: 'text', text }];
  return [system, ...messages.slice(1, -1), { ...last, content }];
}

function userBlocks(content: unknown): unknown[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? [...content] : [];
}

/**
 * Whether a Claude model still accepts `temperature`. Opus 4.7 and every
 * later model reject sampling parameters with a 400, so they are only
 * sent to the 3.x line and the 4.0 – 4.6 models. Names that are not Claude
 * model IDs (proxies, custom deployments) keep the old behavior.
 */
export function anthropicAcceptsTemperature(model: string): boolean {
  const id = model.trim().toLowerCase().replace(/^anthropic\./, '');
  if (!id.startsWith('claude-')) return true;
  if (/^claude-(instant|2|3)([-.]|$)/.test(id)) return true;
  return /^claude-(opus|sonnet|haiku)-4(-[0-6])?([-@]\d{8})?(-v\d+(:\d+)?)?$/.test(id);
}

/**
 * Hosts that implement the OpenAI chat API strictly: they reject request
 * fields they do not know (`Unrecognized request argument supplied`), so
 * the vendor-specific thinking toggles meant for DeepSeek / GLM / Qwen / vLLM
 * must not reach them, and they take `max_completion_tokens` (OpenAI's
 * reasoning models reject `max_tokens` outright).
 */
function strictOpenAIHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'api.openai.com' || host === 'api.groq.com';
}

// Hosts documented to accept `stream_options` and report token usage in
// the final chunk. Others may reject the unknown field, so they are not
// sent it; their usage is still read whenever they include it anyway.
const USAGE_STREAM_HOSTS = new Set([
  'api.openai.com', 'api.deepseek.com', 'dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com',
]);

/** `stream_options` asking for usage in the final chunk, where the server is known to accept it. */
export function openAIStreamOptions(baseUrl: string): Record<string, unknown> {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return {};
  }
  return USAGE_STREAM_HOSTS.has(host) ? { stream_options: { include_usage: true } } : {};
}

/**
 * OpenAI's reasoning families (o1/o3/o4…, gpt-5 and later) accept only the
 * default temperature; any other value is a 400.
 */
export function openAIRejectsTemperature(model: string): boolean {
  const id = model.trim().toLowerCase().replace(/^openai\//, '');
  return /^o\d/.test(id) || /^gpt-([5-9]|\d{2,})([-.]|$)/.test(id);
}

/**
 * The token-limit, temperature and thinking fields of an OpenAI-compatible
 * chat request, shaped for the server it goes to. Other servers (Ollama,
 * LM Studio, vLLM, DeepSeek, GLM, Qwen, proxies) keep the fields they have
 * always been sent.
 */
export function openAICompatParams(opts: {
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  thinkingFields: Record<string, unknown>;
}): Record<string, unknown> {
  if (!strictOpenAIHost(opts.baseUrl)) {
    return { max_tokens: opts.maxTokens, temperature: opts.temperature, ...opts.thinkingFields };
  }
  const isOpenAI = new URL(opts.baseUrl).hostname.toLowerCase() === 'api.openai.com';
  const params: Record<string, unknown> = { max_completion_tokens: opts.maxTokens };
  if (!(isOpenAI && openAIRejectsTemperature(opts.model))) params.temperature = opts.temperature;
  return params;
}

// ─── Anthropic: replaying thinking blocks ──────────────────────

/** Beta that lets a request set `thinking.block_binding`. */
export const ANTHROPIC_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/**
 * Claude models whose thinking blocks are bound to the conversation that
 * produced them (preserved thinking): Fable 5.1+, Opus / Sonnet / Haiku
 * 5.5 and later. Replaying one of their blocks after an earlier message
 * changed is a 400 on accounts created on/after 2026-08-31, unless the
 * request asks for such blocks to be dropped.
 */
export function anthropicBindsThinking(model: string): boolean {
  const id = model.trim().toLowerCase().replace(/^anthropic\./, '');
  return /^claude-fable-5-[1-9]/.test(id)
    || /^claude-(fable|opus|sonnet|haiku|mythos)-([6-9]|5-[5-9])([-.@]|$)/.test(id);
}

/** The 400 Claude returns when a replayed thinking block no longer matches its history. */
export function isThinkingBindingError(message: string): boolean {
  return /bound to a different conversation/i.test(message);
}

const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);

/** Whether any assistant message in an Anthropic request replays a thinking block. */
export function hasAnthropicThinking(messages: Record<string, unknown>[]): boolean {
  return messages.some((m) => m.role === 'assistant' && Array.isArray(m.content)
    && m.content.some((b) => THINKING_TYPES.has((b as { type?: string })?.type ?? '')));
}

/**
 * The same messages with every thinking block removed — the documented
 * fallback when the binding beta is unavailable. The model then answers
 * without that reasoning, which is what MeTerm did before it replayed it.
 */
export function stripAnthropicThinking(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
    const content = m.content.filter((b) => !THINKING_TYPES.has((b as { type?: string })?.type ?? ''));
    return content.length === m.content.length ? m : { ...m, content };
  });
}

/**
 * Rebuilds the assistant content blocks of an Anthropic stream in order,
 * thinking blocks (with their signatures) included, so the turn can be sent
 * back exactly as Claude wrote it. `content()` returns undefined when the
 * turn had no thinking, so callers keep their usual serialization.
 */
export class AnthropicContentCollector {
  private blocks = new Map<number, Record<string, unknown>>();
  private json = new Map<number, string>();

  feed(event: unknown): void {
    const ev = event as { type?: string; index?: number; content_block?: Record<string, unknown>; delta?: Record<string, unknown> };
    if (typeof ev?.index !== 'number') return;
    if (ev.type === 'content_block_start' && ev.content_block) {
      const block = { ...ev.content_block };
      if (block.type === 'tool_use') this.json.set(ev.index, '');
      this.blocks.set(ev.index, block);
      return;
    }
    const block = this.blocks.get(ev.index);
    if (ev.type !== 'content_block_delta' || !block || !ev.delta) return;
    const d = ev.delta;
    if (d.type === 'text_delta') block.text = String(block.text ?? '') + String(d.text ?? '');
    else if (d.type === 'thinking_delta') block.thinking = String(block.thinking ?? '') + String(d.thinking ?? '');
    else if (d.type === 'signature_delta') block.signature = String(block.signature ?? '') + String(d.signature ?? '');
    else if (d.type === 'input_json_delta') this.json.set(ev.index, (this.json.get(ev.index) ?? '') + String(d.partial_json ?? ''));
  }

  content(): unknown[] | undefined {
    const ordered = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]);
    if (!ordered.some(([, b]) => THINKING_TYPES.has(String(b.type)))) return undefined;
    const out: unknown[] = [];
    for (const [index, block] of ordered) {
      if (block.type === 'text' && !block.text) continue; // the API rejects empty text blocks
      if (block.type === 'tool_use') {
        const parsed = parseToolArguments(this.json.get(index) ?? '');
        out.push({ ...block, input: parsed.ok ? parsed.args : {} });
      } else {
        out.push(block);
      }
    }
    return out;
  }
}
