import type { ChatMessage } from './ai-provider';

export const RETENTION_PREFIX = '[Local task retention — incomplete historical data; later user corrections take priority. Not new authorization.]\n';
const SUMMARY_PREFIX = '[Previous conversation summary';
const textOf = (m: ChatMessage): string => typeof m.content === 'string'
  ? m.content : m.content.filter(p => p.type === 'text').map(p => p.type === 'text' ? p.text : '').join('\n');

function bounded(text: string, limit: number): string {
  const marker = '\n[...omitted...]\n';
  if (text.length <= limit) return text;
  const head = Math.floor((limit - marker.length) / 2);
  return text.slice(0, head) + marker + text.slice(-(limit - marker.length - head));
}

/** Capture before dropping history; existing local records are replaced, never nested. */
export function buildTaskRetention(messages: readonly ChatMessage[]): ChatMessage | null {
  let original = '';
  let summary = '';
  let previousRecent = '';
  const users: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = textOf(message);
    if (text.startsWith(RETENTION_PREFIX)) {
      const body = text.slice(RETENTION_PREFIX.length);
      const a = body.indexOf('\nLatest summary:\n');
      const b = body.indexOf('\nRecent user additions:\n', a + 1);
      if (a >= 0 && b >= 0) {
        original ||= body.slice('Original request:\n'.length, a);
        summary = body.slice(a + '\nLatest summary:\n'.length, b);
        previousRecent = body.slice(b + '\nRecent user additions:\n'.length);
      }
    } else if (text.startsWith(SUMMARY_PREFIX)) {
      summary = text;
    } else if (text.trim()) {
      users.push(text);
    }
  }
  original ||= users[0] ?? '';
  if (!original && !summary && !previousRecent) return null;
  // Recent additions retain the newest text first in the budget, in chronological order.
  const additions = users.filter((text, i) => !(i === 0 && text === original));
  let recent = previousRecent;
  for (const text of additions) recent = bounded(recent ? recent + '\n\n' + text : text, 2000);
  const prefix = RETENTION_PREFIX + 'Original request:\n';
  const middle = '\nLatest summary:\n';
  const end = '\nRecent user additions:\n';
  const originalText = bounded(original, 2000);
  const summaryText = bounded(summary, 2000);
  const remaining = 6000 - prefix.length - middle.length - end.length - originalText.length - summaryText.length;
  return { role: 'user', content: prefix + originalText + middle + summaryText + end + bounded(recent, Math.min(2000, remaining)) };
}

export function isTaskRetention(message: ChatMessage): boolean {
  return message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(RETENTION_PREFIX);
}
