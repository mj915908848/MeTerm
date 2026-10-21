import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { classifyError } from '../src/ai-agent-errors.ts';

const rustSource = readFileSync(new URL('../src-tauri/src/commands/ai.rs', import.meta.url), 'utf8');

test('transport errors from the Rust stream broker are retried as network errors', () => {
  const messages = ['request', 'stream'].flatMap(stage => [
    `AI provider ${stage} timed out`,
    `AI provider ${stage} failed: connection error`,
    `AI provider ${stage} failed: connection closed`,
  ]);
  for (const message of messages) {
    assert.equal(classifyError(new Error(message)).category, 'network', message);
  }
  // Keep this list in step with transport_error() in ai.rs.
  for (const suffix of ['timed out', 'failed: connection error', 'failed: connection closed']) {
    assert.ok(rustSource.includes(`"{stage} ${suffix}"`), suffix);
  }
});

test('provider HTTP errors keep their own categories', () => {
  assert.equal(classifyError(new Error('HTTP 401: invalid key')).category, 'auth');
  assert.equal(classifyError(new Error('HTTP 503: overloaded')).category, 'server_error');
});
