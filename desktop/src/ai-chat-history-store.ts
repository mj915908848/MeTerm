// ─── AI chat history: what goes to disk, and what the history list reads ───
//
// Pure module (type-only imports, no Tauri / DOM) so it runs under `node --test`.
//
// A saved conversation is two files:
//   chat-history/<id>.json        the full conversation (ChatConversation)
//   chat-history/index/<id>.json  a small summary (ConversationSummary)
// The history list reads only the summaries; the full file is read when one
// conversation is opened. One summary per conversation, never a shared index
// file, so two windows saving different conversations cannot lose each other's
// entries.

import type { ConvEntry, ChatConversation } from './ai-capsule-types';
import type { ConversationHost } from './ai-conversation-host';

export const CHAT_DIR = 'chat-history';
export const SUMMARY_DIR = `${CHAT_DIR}/index`;

/** Saved length of one tool result. The live turn already used the full output;
 *  restoring a conversation compacts old outputs anyway. */
export const HISTORY_RESULT_LIMIT = 20_000;
/** Text per conversation the history search can match. */
export const SEARCH_TEXT_LIMIT = 8_000;
/** Choices offered in Settings; 0 keeps every conversation. */
export const CHAT_HISTORY_LIMITS = [50, 100, 200, 500, 0] as const;
export const DEFAULT_CHAT_HISTORY_LIMIT = 200;

export interface ConversationSummary {
  id: string;
  hostBinding?: ConversationHost;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Text of the non-tool messages, capped, for the history search. */
  searchText: string;
}

export function summaryPath(id: string): string {
  return `${SUMMARY_DIR}/${id}.json`;
}

function clipResult(text: string): string {
  if (text.length <= HISTORY_RESULT_LIMIT) return text;
  const head = text.slice(0, HISTORY_RESULT_LIMIT - 4_000);
  const tail = text.slice(-4_000);
  return `${head}\n…[${text.length - head.length - tail.length} chars not kept in history]…\n${tail}`;
}

/**
 * The copy of `messages` that is written to disk. The in-memory conversation is
 * left untouched.
 * - type_text payloads are what the agent typed into prompts (passwords among
 *   them), so only their length is kept, as in the audit log.
 * - Images returned by tools (screenshots) are dropped for a one-line note:
 *   they are most of a file's size and a restored run does not need them.
 *   Images the user attached are kept.
 * - Long tool results keep their head and tail.
 */
export function entriesForHistory(messages: ConvEntry[]): ConvEntry[] {
  return messages.map((entry) => {
    if (entry.type !== 'tool_call') return entry;
    let args = entry.args;
    if (entry.toolName === 'type_text' && typeof args.text === 'string') {
      args = { ...args, text: `<redacted ${args.text.length} chars>` };
    }
    let result = entry.result === null ? null : clipResult(entry.result);
    const omitted = entry.images?.length ?? 0;
    if (omitted > 0) {
      result = `${result ?? ''}${result ? '\n' : ''}[${omitted} image(s) not kept in history]`;
    }
    const { images: _images, ...rest } = entry;
    return { ...rest, args, result };
  });
}

export function buildSummary(conv: ChatConversation): ConversationSummary {
  let searchText = '';
  for (const message of conv.messages) {
    if (message.type === 'tool_call' || !message.content) continue;
    searchText += (searchText ? '\n' : '') + message.content;
    if (searchText.length >= SEARCH_TEXT_LIMIT) { searchText = searchText.slice(0, SEARCH_TEXT_LIMIT); break; }
  }
  return {
    id: conv.id,
    hostBinding: conv.hostBinding,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    searchText,
  };
}

/** Parse a summary file; anything malformed is treated as missing. */
export function parseSummary(text: string, id: string): ConversationSummary | null {
  try {
    const raw = JSON.parse(text) as Partial<ConversationSummary>;
    if (!raw || raw.id !== id || typeof raw.title !== 'string' || typeof raw.updatedAt !== 'number'
        || typeof raw.messageCount !== 'number') return null;
    return {
      id, hostBinding: raw.hostBinding, title: raw.title,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : raw.updatedAt,
      updatedAt: raw.updatedAt, messageCount: raw.messageCount,
      searchText: typeof raw.searchText === 'string' ? raw.searchText : '',
    };
  } catch { return null; }
}

/** Ids beyond `limit`, oldest first out, never one in `keep` (open in a tab). */
export function conversationsToPrune(summaries: ConversationSummary[], limit: number, keep: ReadonlySet<string>): string[] {
  if (!(limit > 0) || summaries.length <= limit) return [];
  const newestFirst = [...summaries].sort((a, b) => b.updatedAt - a.updatedAt);
  return newestFirst.slice(limit).filter(s => !keep.has(s.id)).map(s => s.id);
}
