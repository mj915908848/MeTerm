import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPACT_SYSTEM_PROMPT, findCompactSplit, clipSummaryEvidence } from '../src/ai-agent-compact-policy.ts';
import type { ChatMessage } from '../src/ai-provider.ts';

test('summary prioritizes goal, authority, evidence, and pending work across repeated compactions', () => {
  for (const section of ['Goal:', 'Constraints:', 'Verified state:', 'Pending:']) {
    assert.ok(COMPACT_SYSTEM_PROMPT.includes(section));
  }
  assert.match(COMPACT_SYSTEM_PROMPT, /Never invent approval/);
  assert.match(COMPACT_SYSTEM_PROMPT, /previous summary/);
  assert.match(COMPACT_SYSTEM_PROMPT, /Never describe planned work as completed/);
});

test('split never strands results from a multi-tool assistant batch', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'goal' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'read_terminal', arguments: '{}' } },
      { id: 'b', type: 'function', function: { name: 'read_terminal', arguments: '{}' } },
    ] },
    { role: 'tool', content: 'a', tool_call_id: 'a' },
    { role: 'tool', content: 'b', tool_call_id: 'b' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'next' },
  ];
  assert.equal(findCompactSplit(messages, 3), 1);
  assert.equal(findCompactSplit(messages, 4), 1);
  assert.equal(findCompactSplit(messages, 2), 4);
  assert.equal(findCompactSplit([], 6), 0);
});

test('long evidence retains initial context and final error without exceeding text budget', () => {
  const clipped = clipSummaryEvidence('START\n' + 'x'.repeat(3000) + '\nFINAL ERROR', 1200);
  assert.ok(clipped.startsWith('START'));
  assert.ok(clipped.endsWith('FINAL ERROR'));
  assert.ok(clipped.length < 1250);
  assert.equal(clipSummaryEvidence('short', 1200), 'short');
});
