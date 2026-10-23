import assert from 'node:assert/strict';
import test from 'node:test';
import { clearStoredOutputs, readStoredOutput, saveOutput, truncateWithRecall } from '../src/ai-output-store.ts';

const log = Array.from({ length: 1000 }, (_, i) => (i === 500 ? 'ERROR: disk full' : `line ${i + 1}`)).join('\n');

test('short output passes through untouched and is not stored', () => {
  clearStoredOutputs();
  assert.equal(truncateWithRecall('ok', 100), 'ok');
  assert.match(readStoredOutput('out-1', {}), /^Error: no stored output/);
});

test('long output keeps whole lines, favours the tail, and can be read back', () => {
  clearStoredOutputs();
  const shown = truncateWithRecall(log, 3000);
  assert.ok(shown.length < 3400);
  assert.match(shown, /^line 1\n/);
  assert.match(shown, /line 1000$/);
  const id = /saved as "(out-\d+)"/.exec(shown)![1];
  const gap = /lines (\d+)-(\d+) of 1000 omitted/.exec(shown)!;
  assert.ok(Number(gap[1]) < 501 && Number(gap[2]) > 501);
  assert.doesNotMatch(shown, /disk full/);
  assert.equal(readStoredOutput(id, { pattern: 'error' }), '501: ERROR: disk full');
  assert.match(readStoredOutput(id, { offset: 500, limit: 2 }), /^line 500\nERROR: disk full\n\n--- "out-\d+" lines 500-501 of 1000\. Next: offset=502\. ---$/);
  assert.match(readStoredOutput(id, { pattern: '(' }), /^Error: invalid pattern/);
});

test('the store evicts the oldest outputs', () => {
  clearStoredOutputs();
  const first = saveOutput('a');
  for (let i = 0; i < 30; i++) saveOutput('b');
  assert.match(readStoredOutput(first, {}), /^Error: no stored output/);
});
