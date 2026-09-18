// ─── AI Agent: LLM-based History Summarization ─────────────
// When the conversation approaches the model's context window,
// we ask the model to summarize everything except the most recent
// few turns, then replace the summarized slice with a single
// synthetic user message holding the summary.
//
// Fallback: if summarization fails (network error, rate limit,
// model refusal), the caller should fall back to the purely-local
// compressContext() strategy in ai-agent-history.ts.

import type {
  AIProvider,
  ChatMessage,
  StreamCallbacks,
} from './ai-provider';
import { contentToText } from './ai-provider';
import { COMPACT_SYSTEM_PROMPT, findCompactSplit, clipSummaryEvidence } from './ai-agent-compact-policy';
import { abortableOperation } from './ai-abortable-operation';

/** Number of most recent messages to keep verbatim. Everything before
 *  this window gets summarized into a single synthetic user message.
 *  We keep enough to preserve the immediate context the model is
 *  actively reasoning about (current tool call chain). */
export const COMPACT_KEEP_RECENT = 6;

/** Minimum message count before summarization is worth attempting. */
export const COMPACT_MIN_MESSAGES = 10;

/** Max output tokens for the summarization call itself. */
const COMPACT_MAX_OUTPUT = 2000;

/**
 * Summarize the "older" portion of a conversation via one LLM call.
 *
 * Contract:
 *   • Returns a mutated copy of `messages` with the oldest slice replaced
 *     by a single synthetic user message containing the summary.
 *   • If summarization fails for any reason, returns `null` — the caller
 *     MUST fall back to local compression.
 *   • Messages are not mutated in place; the caller swaps the array.
 *
 * @param messages  The full conversation (without system prompt).
 * @param provider  The provider to call for the summary (reuse current).
 * @param signal    Optional abort signal — summarization respects it.
 */
export async function summarizeOlderMessages(
  messages: ChatMessage[],
  provider: AIProvider,
  signal?: AbortSignal,
): Promise<ChatMessage[] | null> {
  if (messages.length < COMPACT_MIN_MESSAGES) return null;

  // Split: everything up to (length - COMPACT_KEEP_RECENT) gets summarized. The
  // policy already moves the boundary back so tool batches stay intact.
  const splitIndex = findCompactSplit(messages, COMPACT_KEEP_RECENT);
  if (splitIndex < 2) return null;

  const toSummarize = messages.slice(0, splitIndex);
  const toKeep = messages.slice(splitIndex);
  if (toSummarize.length === 0) return null;

  // Build a plain-text transcript for the summarizer to read.
  const transcript = formatTranscriptForSummary(toSummarize);

  // Make a single LLM call. We bypass tool support — the summarizer
  // doesn't need it, and not all providers handle tools uniformly.
  const summaryMessages: ChatMessage[] = [
    { role: 'system', content: COMPACT_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        'Here is the conversation to summarize. Produce the summary now:\n\n' +
        '---\n' +
        transcript +
        '\n---',
    },
  ];

  let summary: string;
  try {
    summary = await callLLMOnce(provider, summaryMessages, signal);
  } catch {
    return null;
  }

  if (!summary || summary.trim().length === 0) return null;

  // Synthesize a single "user" message containing the summary.
  // Using role=user is portable across providers and avoids the edge
  // cases of injecting a synthetic system message mid-stream.
  const summaryMessage: ChatMessage = {
    role: 'user',
    content:
      '[Previous conversation summary — older turns have been compacted to fit the context window]\n\n' +
      summary.trim() +
      '\n\n[End of summary. The conversation continues below.]',
  };

  return [summaryMessage, ...toKeep];
}

/** Flatten a message array into a plain-text transcript. */
function formatTranscriptForSummary(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // system prompt is not interesting
    // Normalize multimodal content to text for summarization.
    const text = contentToText(m.content);
    if (m.role === 'user') {
      parts.push(`USER: ${text.trim()}`);
    } else if (m.role === 'assistant') {
      if (text) parts.push(`ASSISTANT: ${text.trim()}`);
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          parts.push(`TOOL_CALL ${tc.function.name}(${clipJson(tc.function.arguments)})`);
        }
      }
    } else if (m.role === 'tool') {
      const head = clipSummaryEvidence(text, 1200);
      parts.push(`TOOL_RESULT ${m.name ?? ''}: ${head}`);
    }
  }
  return parts.join('\n\n');
}

function clipJson(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 200) return trimmed;
  return trimmed.slice(0, 200) + '...';
}

/**
 * Fire a single non-streaming-ish LLM call. We still receive a
 * streaming response — we just concatenate the tokens into one string.
 */
async function callLLMOnce(
  provider: AIProvider,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
  try {
    return await abortableOperation<string>(controller.signal, (resolve, reject) => {
    let collected = '';
    let settled = false;

    const callbacks: StreamCallbacks = {
      onToken: (t) => { if (!controller.signal.aborted) collected += t; },
      onComplete: (full) => {
        if (settled) return;
        settled = true;
        resolve(full || collected);
      },
      onError: (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      },
    };

    const wrapped: StreamCallbacks = {
      ...callbacks,
      onComplete: (full, tcs) => {
        clearTimeout(timer);
        callbacks.onComplete(full, tcs);
      },
      onError: (err) => {
        clearTimeout(timer);
        callbacks.onError(err);
      },
    };

    // No tools passed — pure chat call.
    try {
      provider.chat(messages, wrapped, controller.signal, undefined);
    } catch (e) {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
    });
  } catch (error) {
    if (timedOut) throw new Error('Compact summarization timed out (30s)');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ── Expose max output for callers that want to override provider config ──
export { COMPACT_MAX_OUTPUT };
