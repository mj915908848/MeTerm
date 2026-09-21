import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

/** Slice one method out of a class, from its signature to its closing brace. */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `signature not found: ${signature}`);
  const end = source.indexOf('\n  }', start);
  assert.ok(end > start, `closing brace not found for: ${signature}`);
  return source.slice(start, end);
}

// The panel is a singleton: closing it keeps `sessionId`, so a reopen lands on
// the same session. Gating the poll restart on the session having changed left
// the timer stopped after close() cleared it — the panel then showed stale
// numbers forever. These guards pin that restart to be unconditional.
test('the server-info panel restarts polling when reopened on the same session', () => {
  const body = methodBody(read('server-info-panel.ts'), '  syncToActiveSession(): void {');
  assert.ok(body.includes('this.startPolling();'), 'syncToActiveSession must start polling');
  assert.ok(
    !/if\s*\(\s*changed\s*\)\s*this\.startPolling\(\)/.test(body),
    'startPolling() must not be gated on `changed` — close() stops the timer and the session is unchanged on reopen',
  );
});

// Unconditional calls are only safe because the method no-ops while running;
// without this it would stack one interval per sync.
test('startPolling stays idempotent so an unconditional call cannot stack intervals', () => {
  const body = methodBody(read('server-info-panel.ts'), '  private startPolling(): void {');
  assert.ok(
    /if\s*\(this\.timer !== null\)\s*return;/.test(body),
    'startPolling() must return early while the timer is already running',
  );
});

// The registry is keyed by session id; a missing unregister leaks one entry per
// session that ever existed.
test('destroying a drawer releases its server-info container registration', () => {
  const source = read('drawer.ts');
  const start = source.indexOf('  destroy(sessionId: string): void {');
  assert.ok(start >= 0, 'destroy() not found in drawer.ts');
  const body = source.slice(start, source.indexOf('\n  }', start));
  assert.ok(
    body.includes('unregisterSysInfoContainer(sessionId)'),
    'destroy() must unregister the panel container for the session',
  );
});
