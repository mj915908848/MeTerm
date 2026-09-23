import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const panel = read('server-info-panel.ts');
const toolbar = read('toolbar.ts');

/** Slice a top-level function out of a module, from its signature to its brace. */
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `signature not found: ${signature}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `closing brace not found for: ${signature}`);
  return source.slice(start, end);
}

/** Slice one method out of a class, from its signature to its closing brace. */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `signature not found: ${signature}`);
  const end = source.indexOf('\n  }', start);
  assert.ok(end > start, `closing brace not found for: ${signature}`);
  return source.slice(start, end);
}

// Server info is an SSH-only feature: a local session has no remote side, and a
// JumpServer session's Koko connection never granted an exec channel. The drawer
// instance resolves that type once per session, so the panel must read it rather
// than re-deriving "is this remote?" from its own ideas.
test('only plain SSH sessions are describable, and the type comes from the drawer', () => {
  const body = fnBody(panel, 'export function hasRemoteServerInfo(');
  assert.ok(
    body.includes("executorType === 'ssh'"),
    "hasRemoteServerInfo must accept exactly executorType === 'ssh'",
  );
  assert.ok(
    body.includes('DrawerManager.getInstance(sessionId)'),
    'the session type must come from the DrawerManager instance, not a local re-derivation',
  );
  assert.ok(
    /if \(!sessionId\) return false;/.test(body),
    'a null session must be rejected up front',
  );
});

// Switching to a local/JumpServer tab must stop the 5s poll and hide the panel.
// Keeping the panel visible with a placeholder is what this replaced.
test('switching to a session without remote server info stops polling and hides the panel', () => {
  const body = methodBody(panel, '  syncToActiveSession(): void {');
  assert.ok(
    body.includes('!hasRemoteServerInfo(sessionId)'),
    'syncToActiveSession must bail on sessions that cannot answer sysinfo',
  );
  const guard = body.indexOf('!hasRemoteServerInfo(sessionId)');
  const stop = body.indexOf('this.stopPolling()', guard);
  const hide = body.indexOf("this.panel.style.display = 'none'", guard);
  assert.ok(stop > guard, 'the guard must stop polling');
  assert.ok(hide > guard, 'the guard must hide the panel');
  assert.ok(
    body.indexOf('this.startPolling()', guard) > stop,
    'polling must only start on the path that passed the guard',
  );
});

// open() fires one request directly, bypassing the syncToActiveSession guard, so
// the gate has to be repeated here or a local session still gets a request.
test('requestSysInfo refuses sessions without remote server info', () => {
  const body = methodBody(panel, '  private requestSysInfo(forceProcesses = false): void {');
  const guard = body.indexOf('!hasRemoteServerInfo(sessionId)');
  assert.ok(guard > 0, 'requestSysInfo must gate on hasRemoteServerInfo');
  assert.ok(
    guard < body.indexOf("requestServerInfo('sysinfo')"),
    'the guard must precede the request, not follow it',
  );
});

// The panel used to paint "server info is available for SSH sessions only" into
// the body. That message has no entry point now: the toolbar hides the button
// and syncToActiveSession hides the panel. A placeholder coming back would mean
// the gate regressed.
test('no availability placeholder is painted into the panel body', () => {
  assert.ok(
    !panel.includes('sip-empty'),
    'the panel must not render a placeholder for sessions it cannot describe',
  );
  const body = methodBody(panel, '  private render(): void {');
  assert.ok(
    body.includes("instance.executorType !== 'ssh'"),
    'render() must still bail out for a non-SSH session',
  );
});

// One predicate, one place to change: the toolbar must not grow its own copy of
// "is this the kind of session that has server info".
test('the toolbar renders the entry from the shared predicate', () => {
  assert.ok(
    toolbar.includes("import { ServerInfoPanel, hasRemoteServerInfo } from './server-info-panel';"),
    'toolbar must import the shared predicate',
  );
  assert.ok(
    toolbar.includes('hasActiveSession && hasRemoteServerInfo(siSessionId)'),
    'the server-info button must be gated on hasRemoteServerInfo',
  );
  assert.ok(
    !toolbar.includes('executorType'),
    'toolbar must not re-derive the session type — use hasRemoteServerInfo',
  );
});

// The backend used to answer every non-SSH session with the *local* machine's
// hostname/OS. For a JumpServer session that labelled this machine's data as the
// remote asset's; it now has to refuse instead.
test('the backend refuses a JumpServer session instead of returning local info', () => {
  const rust = fs.readFileSync(
    new URL('../src-tauri/src/server/server_info.rs', import.meta.url),
    'utf8',
  );
  const start = rust.indexOf('pub async fn handle_server_info');
  assert.ok(start >= 0, 'handle_server_info not found');
  const head = rust.slice(start, rust.indexOf('// SSH session — run commands via exec channel'));
  const rejectAt = head.indexOf('"jumpserver"');
  const localAt = head.indexOf('handle_local_server_info(&req_type)');
  assert.ok(rejectAt > 0, 'the jumpserver branch must be handled explicitly');
  assert.ok(
    localAt > rejectAt,
    'the local-info branch must come after the jumpserver rejection, so jumpserver never reaches it',
  );
});
