// ─── AI Agent: Message History Management ─────────────────────
// Pure helpers for trimming and compressing the conversation
// history while preserving tool_call / tool_result pairs.
//
// Three layered strategies, modeled on Claude Code's compact.ts:
//   • trimHistory()    — hard cap by total characters (oldest first).
//   • microCompact()   — in-place truncation of long tool_result
//     messages before EVERY LLM call. Cheap, no model call.
//   • compressContext() — escalated compression on context overflow
//     (tool outputs + assistant text + oldest message drop).

import type { ChatMessage, ContentPart } from './ai-provider';
// Explicit `.ts` extensions are required: these modules are loaded directly by
// `node --test`, which does not resolve extensionless relative imports.
import { MESSAGE_HISTORY_MAX_CHARS } from './ai-history-budget.ts';
import { buildTaskRetention, isTaskRetention } from './ai-agent-retention.ts';

/** Char length of a ChatMessage.content, used by the character-based
 *  history caps. Image parts are scored at a flat 1500 chars to match the
 *  rough token cost of a small image (~ 300-500 tokens) so they
 *  participate in the budget. */
function contentCharLength(content: string | ContentPart[]): number {
  if (typeof content === 'string') return content.length;
  let total = 0;
  for (const p of content) {
    if (p.type === 'text') total += p.text.length;
    else total += 1500;
  }
  return total;
}

/** True iff the content is the simple-string form. */
function isStringContent(
  content: string | ContentPart[],
): content is string {
  return typeof content === 'string';
}

/** Flat token cost of an image part (a small screenshot is ~300-500). */
const IMAGE_TOKENS = 400;

/**
 * Token estimate for text. ASCII runs at ~4 chars per token, but CJK and
 * other non-ASCII text is roughly one token per character (often more),
 * so a flat chars/4 undercounted Chinese conversations about 4x and
 * compaction fired long after the real context had overflowed.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x80) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

function estimateContentTokens(content: string | ContentPart[]): number {
  if (typeof content === 'string') return estimateTextTokens(content);
  let total = 0;
  for (const p of content) total += p.type === 'text' ? estimateTextTokens(p.text) : IMAGE_TOKENS;
  return total;
}

/** Estimate total token count of a message array, including tool calls. */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  let tokens = 0;
  for (const m of messages) {
    tokens += estimateContentTokens(m.content);
    for (const tc of m.tool_calls ?? []) {
      tokens += estimateTextTokens(tc.function.name) + estimateTextTokens(tc.function.arguments);
    }
  }
  return tokens;
}

/**
 * Auto-compact decision: should we pre-emptively compress history
 * before the NEXT LLM call, based on estimated tokens?
 *
 * Threshold: 75% of (contextBudget − maxOutputTokens − headroom) so we
 * still have room for the reply. A model's context window is shared by
 * input and output, hence the subtraction.
 *
 * Callers should pass REAL values: `contextBudgetTokens` from the
 * aiHistoryBudgetTokens setting, `maxOutputTokens` from aiMaxTokens, and
 * `fixedPromptTokens` for what is sent besides the history (system
 * prompt and tool definitions).
 * The defaults exist only so tests and offline callers work — relying on
 * them is exactly what previously made aiMaxTokens a no-op here.
 */
export function shouldAutoCompact(
  messages: ChatMessage[],
  contextBudgetTokens = 128_000,
  maxOutputTokens = 4_000,
  fixedPromptTokens = 0,
): boolean {
  const headroom = 2_000;
  const budget = contextBudgetTokens - maxOutputTokens - headroom;
  const threshold = Math.floor(budget * 0.75);
  return estimateMessageTokens(messages) + fixedPromptTokens > threshold;
}

const OLDER_TOOL_MARKER = /\n\.\.\.\(older tool output truncated; \d+ chars\)$/;

/**
 * MicroCompact: truncate long tool_result messages in-place so they
 * don't bloat every subsequent LLM request.
 *
 * Rationale: the most recent tool output already informs the next
 * turn — older tool outputs only need a summary / marker.  This is
 * cheap (no LLM call), idempotent, and preserves message structure.
 *
 * Keeps the most recent `keepRecent` tool messages untouched so the
 * model has the latest context in full.
 *
 * Every rewrite of an earlier message ends the provider's prompt-cache
 * hit at that message, so truncation waits until it would save at least
 * `minSavingsChars` and then shortens every eligible message at once,
 * instead of moving the cut by one message on every iteration. Messages
 * that already carry the marker are left alone.
 *
 * Returns true if any message was modified.
 */
export function microCompact(
  messages: ChatMessage[],
  maxOlderToolChars = 800,
  keepRecent = 2,
  minSavingsChars = 8000,
): boolean {
  let toolCount = 0;
  // Count tool messages to know which ones are "recent" (from the end).
  for (const m of messages) if (m.role === 'tool') toolCount++;
  if (toolCount <= keepRecent) return false;

  const toKeepFrom = toolCount - keepRecent;
  const candidates: Array<ChatMessage & { content: string }> = [];
  let savings = 0;
  let seenTool = 0;

  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    seenTool++;
    if (seenTool > toKeepFrom) break; // reached "recent" region
    // Only text-only tool results can be truncated safely; multimodal
    // tool results (image from read_screen) are always preserved as-is
    // because their value is not reducible via character slicing.
    if (!isStringContent(msg.content)) continue;
    if (msg.content.length <= maxOlderToolChars || OLDER_TOOL_MARKER.test(msg.content)) continue;
    candidates.push(msg as ChatMessage & { content: string });
    savings += msg.content.length - maxOlderToolChars;
  }
  if (candidates.length === 0 || savings < minSavingsChars) return false;

  for (const msg of candidates) {
    msg.content = safeTruncate(
      msg.content,
      maxOlderToolChars,
      `\n...(older tool output truncated; ${msg.content.length} chars)`,
    );
  }
  return true;
}

/**
 * Trim message history by total character count, mutating in place.
 * Removes oldest messages first, preserving tool_call / tool pairs.
 */
export function trimHistory(messages: ChatMessage[]): void {
  const maxChars = MESSAGE_HISTORY_MAX_CHARS;
  let totalChars = messages.reduce((sum, m) => sum + contentCharLength(m.content), 0);
  if (totalChars <= maxChars || messages.length <= 2) return;
  const retention = buildTaskRetention(messages);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTaskRetention(messages[i])) messages.splice(i, 1);
  }
  totalChars = messages.reduce((sum, m) => sum + contentCharLength(m.content), 0);
  const retainedChars = retention ? contentCharLength(retention.content) : 0;

  while (totalChars + retainedChars > maxChars && messages.length > 2) {
    const removed = messages.shift()!;
    totalChars -= contentCharLength(removed.content);

    // If we removed an assistant message with tool_calls,
    // also remove the corresponding tool-result messages
    if (removed.role === 'assistant' && removed.tool_calls) {
      const tcIds = new Set(removed.tool_calls.map((tc) => tc.id));
      for (let i = messages.length - 1; i >= 0; i--) {
        if (
          messages[i].role === 'tool' &&
          tcIds.has(messages[i].tool_call_id!)
        ) {
          totalChars -= contentCharLength(messages[i].content);
          messages.splice(i, 1);
        }
      }
    }
  }
  while (messages[0]?.role === 'tool') messages.shift();
  if (retention) messages.unshift(retention);
}

/**
 * Truncate at a clean boundary (last newline within a small lookback window)
 * so we don't leave half an XML/code-fence element dangling. Models
 * occasionally parrot dangling fragments like `</arg_value>` back into
 * the next turn's reasoning when we cut mid-structure.
 */
function safeTruncate(s: string, max: number, suffix: string): string {
  if (s.length <= max) return s;
  let cut = max;
  const newline = s.lastIndexOf('\n', max);
  if (newline > max - 200 && newline > 0) cut = newline;
  return s.slice(0, cut) + suffix;
}

/**
 * Aggressively compress history when the model reports context overflow.
 *   Phase 1: Truncate long tool outputs and assistant messages
 *   Phase 2: Remove oldest message turns (keeping tool pairs intact)
 *
 * Returns true if any compression was performed.
 */
export function compressContext(messages: ChatMessage[]): boolean {
  if (messages.length <= 4) return false;
  const retention = buildTaskRetention(messages);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTaskRetention(messages[i])) messages.splice(i, 1);
  }

  let compressed = false;
  const TOOL_MAX = 200;
  const ASSISTANT_MAX = 500;

  // Phase 1: Truncate long content (text-only messages)
  for (const msg of messages) {
    if (!isStringContent(msg.content)) continue;
    if (msg.role === 'tool' && msg.content.length > TOOL_MAX) {
      msg.content = safeTruncate(msg.content, TOOL_MAX, '\n...(output truncated)');
      compressed = true;
    }
    if (msg.role === 'assistant' && msg.content.length > ASSISTANT_MAX) {
      msg.content = safeTruncate(msg.content, ASSISTANT_MAX, '\n...(truncated)');
      compressed = true;
    }
  }

  // Phase 2: Remove oldest messages until count halved
  // Keeps tool_call/tool_result pairs together
  const targetCount = Math.max(4, Math.ceil(messages.length * 0.5));

  while (messages.length > targetCount) {
    const first = messages.shift()!;
    compressed = true;

    // If we removed an assistant with tool_calls, also remove its tool results
    if (first.role === 'assistant' && first.tool_calls) {
      const tcIds = new Set(first.tool_calls.map((tc) => tc.id));
      while (
        messages.length > 0 &&
        messages[0].role === 'tool' &&
        tcIds.has(messages[0].tool_call_id!)
      ) {
        messages.shift();
      }
    }

    // Clean up any orphaned tool results at the start
    while (messages.length > 0 && messages[0].role === 'tool') {
      messages.shift();
    }
  }

  if (retention) messages.unshift(retention);
  return compressed;
}
