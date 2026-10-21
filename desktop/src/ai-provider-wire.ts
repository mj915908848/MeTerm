// ─── AI Provider: Wire-format Helpers ───────────────────────────
// Pure parsing of what providers send back: SSE lines, error events
// inside a 200 stream, and tool-call argument JSON. No imports beyond
// types, so `node --test` can load it directly.

import type { ProviderType } from './ai-provider';

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
