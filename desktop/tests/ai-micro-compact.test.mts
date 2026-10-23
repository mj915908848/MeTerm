import assert from 'node:assert/strict';
import test from 'node:test';
import { microCompact } from '../src/ai-agent-history.ts';

const tool = (id: string, size: number): any => ({ role: 'tool', tool_call_id: id, content: 'x'.repeat(size) });

test('older tool outputs are only truncated once the saving is worth a cache miss', () => {
  const messages = [tool('a', 3000), tool('b', 3000), tool('c', 3000), tool('d', 3000)];
  // Two older outputs would save 4400 chars: not yet.
  assert.equal(microCompact(messages), false);
  assert.equal(messages[0].content.length, 3000);

  messages.push(tool('e', 3000), tool('f', 3000));
  // Four older outputs save 8800 chars: all of them are cut together.
  assert.equal(microCompact(messages), true);
  for (const m of messages.slice(0, 4)) assert.match(m.content, /older tool output truncated; 3000 chars\)$/);
  for (const m of messages.slice(4)) assert.equal(m.content.length, 3000);
});

test('already truncated outputs are never rewritten again', () => {
  const messages = [tool('a', 3000), tool('b', 3000), tool('c', 3000)];
  assert.equal(microCompact(messages, 800, 2, 0), true);
  const once = messages[0].content;
  messages.push(tool('d', 10));
  assert.equal(microCompact(messages, 800, 2, 0), true); // only 'b' is new
  assert.equal(messages[0].content, once);
  assert.equal(microCompact(messages, 800, 2, 0), false);
});
