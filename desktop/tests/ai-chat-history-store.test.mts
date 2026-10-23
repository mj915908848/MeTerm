import assert from 'node:assert/strict';
import test from 'node:test';
import {
  entriesForHistory, buildSummary, parseSummary, conversationsToPrune,
  HISTORY_RESULT_LIMIT, SEARCH_TEXT_LIMIT,
} from '../src/ai-chat-history-store.ts';

const image = { mediaType: 'image/png' as const, data: 'AAAA' };

test('type_text payloads are stored as their length only', () => {
  const [entry] = entriesForHistory([{ type: 'tool_call', toolName: 'type_text', args: { text: 'hunter2', pane: 1 },
    result: 'ok', isError: false, timestamp: 1 }]) as any[];
  assert.deepEqual(entry.args, { text: '<redacted 7 chars>', pane: 1 });
});

test('tool images are dropped with a note; user images and the live entries are untouched', () => {
  const live: any[] = [
    { type: 'user', content: 'look', images: [image], timestamp: 1 },
    { type: 'tool_call', toolName: 'screenshot', args: {}, result: 'captured', isError: false, images: [image, image], timestamp: 2 },
    { type: 'tool_call', toolName: 'screenshot', args: {}, result: null, isError: false, images: [image], timestamp: 3 },
  ];
  const saved = entriesForHistory(live) as any[];
  assert.equal(saved[0].images.length, 1);
  assert.equal(saved[1].images, undefined);
  assert.equal(saved[1].result, 'captured\n[2 image(s) not kept in history]');
  assert.equal(saved[2].result, '[1 image(s) not kept in history]');
  assert.equal(live[1].images.length, 2);
  assert.equal(live[1].result, 'captured');
});

test('long tool results keep head and tail within the limit', () => {
  const long = 'h'.repeat(30_000) + 'TAIL';
  const [entry] = entriesForHistory([{ type: 'tool_call', toolName: 'run_command', args: {}, result: long, isError: false, timestamp: 1 }]) as any[];
  assert.ok(entry.result.length < HISTORY_RESULT_LIMIT + 100);
  assert.ok(entry.result.startsWith('hhh'));
  assert.ok(entry.result.endsWith('TAIL'));
  assert.match(entry.result, /chars not kept in history/);
  const [short] = entriesForHistory([{ type: 'tool_call', toolName: 'run_command', args: {}, result: 'fine', isError: false, timestamp: 1 }]) as any[];
  assert.equal(short.result, 'fine');
});

test('summary carries list fields and searchable text without tool output', () => {
  const summary = buildSummary({ id: 'c1', title: 'goal', createdAt: 1, updatedAt: 5, hostBinding: { kind: 'local' }, messages: [
    { type: 'user', content: 'restart nginx', timestamp: 1 },
    { type: 'tool_call', toolName: 'run_command', args: {}, result: 'SECRET_OUTPUT', isError: false, timestamp: 2 },
    { type: 'assistant', content: 'done', timestamp: 3 },
  ] });
  assert.equal(summary.messageCount, 3);
  assert.equal(summary.searchText, 'restart nginx\ndone');
  assert.deepEqual(summary.hostBinding, { kind: 'local' });
  const huge = buildSummary({ id: 'c2', title: 't', createdAt: 1, updatedAt: 1,
    messages: [{ type: 'user', content: 'x'.repeat(SEARCH_TEXT_LIMIT * 2), timestamp: 1 }] });
  assert.equal(huge.searchText.length, SEARCH_TEXT_LIMIT);
});

test('summary parsing rejects malformed or mismatched files', () => {
  const good = JSON.stringify({ id: 'a', title: 't', updatedAt: 2, messageCount: 1, searchText: 's' });
  assert.equal(parseSummary(good, 'a')?.createdAt, 2);
  assert.equal(parseSummary(good, 'b'), null);
  assert.equal(parseSummary('{', 'a'), null);
  assert.equal(parseSummary(JSON.stringify({ id: 'a', title: 't' }), 'a'), null);
});

test('pruning removes the oldest beyond the limit and never an open conversation', () => {
  const summaries = [1, 2, 3, 4, 5].map(n => ({ id: `c${n}`, title: '', createdAt: n, updatedAt: n, messageCount: 1, searchText: '' }));
  assert.deepEqual(conversationsToPrune(summaries, 3, new Set()), ['c2', 'c1']);
  assert.deepEqual(conversationsToPrune(summaries, 3, new Set(['c1'])), ['c2']);
  assert.deepEqual(conversationsToPrune(summaries, 0, new Set()), []);
  assert.deepEqual(conversationsToPrune(summaries, 10, new Set()), []);
});
