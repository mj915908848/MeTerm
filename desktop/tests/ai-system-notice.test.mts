import assert from 'node:assert/strict';
import test from 'node:test';
import { stripNoticeRule } from '../src/ai-system-notice.ts';

test('legacy "── text ──" notices lose their rule lines', () => {
  assert.equal(stripNoticeRule('── 思考已开 ──'), '思考已开');
  assert.equal(stripNoticeRule('Rate limited, retrying (1/3)'), 'Rate limited, retrying (1/3)');
  assert.equal(stripNoticeRule('a - b'), 'a - b');
});
