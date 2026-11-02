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
export const SEARCH_TEXT_LIMIT = 32_000;
/** Bumped when summaries gain content; an older summary is rebuilt once from its file. */
export const SUMMARY_VERSION = 2;
/** Choices offered in Settings; 0 keeps every conversation. */
export const CHAT_HISTORY_LIMITS = [50, 100, 200, 500, 0] as const;
export const DEFAULT_CHAT_HISTORY_LIMIT = 200;

export interface ConversationSummary {
  version?: number;
  id: string;
  hostBinding?: ConversationHost;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Text of the messages and the commands the agent ran (never tool output),
   *  capped, for the history search. */
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

/** The command a tool call ran, when it has one: searchable, unlike its output. */
function toolCommand(entry: ConvEntry): string {
  if (entry.type !== 'tool_call') return '';
  const command = entry.args.command ?? entry.args.cmd;
  return typeof command === 'string' ? command : '';
}

export function buildSummary(conv: ChatConversation): ConversationSummary {
  let searchText = '';
  for (const message of conv.messages) {
    const text = message.type === 'tool_call' ? toolCommand(message) : message.content;
    if (!text) continue;
    searchText += (searchText ? '\n' : '') + text;
    if (searchText.length >= SEARCH_TEXT_LIMIT) { searchText = searchText.slice(0, SEARCH_TEXT_LIMIT); break; }
  }
  return {
    version: SUMMARY_VERSION,
    id: conv.id,
    hostBinding: conv.hostBinding,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    searchText,
  };
}

/** Parse a summary file; anything malformed or older is treated as missing. */
export function parseSummary(text: string, id: string): ConversationSummary | null {
  try {
    const raw = JSON.parse(text) as Partial<ConversationSummary>;
    if (!raw || raw.version !== SUMMARY_VERSION || raw.id !== id || typeof raw.title !== 'string' || typeof raw.updatedAt !== 'number'
        || typeof raw.messageCount !== 'number') return null;
    return {
      version: SUMMARY_VERSION, id, hostBinding: raw.hostBinding, title: raw.title,
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

/**
 * When a conversation last changed: its newest message. Saving a conversation
 * that was only opened, switched away from or closed must not move it to the
 * top of the history list.
 */
export function lastActivity(messages: readonly ConvEntry[], fallback: number): number {
  let latest = 0;
  for (const message of messages) {
    if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) && message.timestamp > latest) {
      latest = message.timestamp;
    }
  }
  return latest > 0 ? latest : fallback;
}

export type HistoryDateGroup = 'today' | 'yesterday' | 'week' | 'earlier';

/** Which date heading a conversation goes under, in local time. */
export function historyDateGroup(timestamp: number, now: number): HistoryDateGroup {
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  if (timestamp >= today) return 'today';
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (timestamp >= yesterday.getTime()) return 'yesterday';
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 6);
  if (timestamp >= weekAgo.getTime()) return 'week';
  return 'earlier';
}

/** The words of a history search, lower-cased; every one must match. */
export function searchKeywords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** `text` cut into runs, each marked when it is a keyword hit (case-insensitive). */
export function highlightRuns(text: string, keywords: readonly string[]): { text: string; hit: boolean }[] {
  if (keywords.length === 0 || !text) return text ? [{ text, hit: false }] : [];
  const lower = text.toLowerCase();
  const hits = new Array<boolean>(text.length).fill(false);
  for (const keyword of keywords) {
    for (let at = lower.indexOf(keyword); at !== -1; at = lower.indexOf(keyword, at + keyword.length)) {
      hits.fill(true, at, at + keyword.length);
    }
  }
  const runs: { text: string; hit: boolean }[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || hits[i] !== hits[start]) {
      runs.push({ text: text.slice(start, i), hit: hits[start] });
      start = i;
    }
  }
  return runs;
}

/**
 * One line of `text` around the first keyword it contains, for showing why a
 * conversation matched. Null when no keyword is in `text`.
 */
export function searchSnippet(text: string, keywords: readonly string[], radius = 40): string | null {
  const lower = text.toLowerCase();
  let at = -1; let length = 0;
  for (const keyword of keywords) {
    const found = lower.indexOf(keyword);
    if (found !== -1 && (at === -1 || found < at)) { at = found; length = keyword.length; }
  }
  if (at === -1) return null;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + length + radius * 2);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}
