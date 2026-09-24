/**
 * Which window a connection from the standalone launcher opens in.
 *
 * The connection window is a singleton (`connections`) but the windows that can
 * open it are not: `main`, plus one `window-*` per "new window". The launcher used
 * to emit a plain broadcast that only the window labelled `main` listened for, so
 * opening a connection from a second window's toolbar raised and focused the
 * *first* window and started the session there — the second window was never a
 * candidate, however focused it was.
 *
 * Three parts hold the fix together, and each is easy to undo by accident:
 *
 *   1. Every app window serves the launcher, not just the first one.
 *   2. A request names the window it is for, and only that window acts on it —
 *      registering the bridge everywhere *without* this would open one session per
 *      open window from a single click.
 *   3. The launcher knows which window it belongs to: recorded by the opener before
 *      the window is created, and re-claimed when a window reuses an open launcher.
 *
 * The behavioural half of 3 — that a claim actually moves the target, and that a
 * label which cannot be a window is refused — is exercised against a live window in
 * connections-window-init.test.mts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const readCapability = (name: string): string =>
  fs.readFileSync(new URL(`../src-tauri/capabilities/${name}`, import.meta.url), 'utf8');

/** Slice from `marker` up to the first top-level closing brace line. */
function bodyAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} was not found`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `${marker} has no end`);
  return source.slice(start, end);
}

// ── 1. Who serves the launcher ──

test('every app window serves the launcher, not only the first one', () => {
  const main = read('main.ts');

  assert.ok(
    !/if\s*\(currentWindowLabel === 'main'\)\s*setupConnectionsWindowBridge\(\)/.test(main),
    "the bridge must not be gated on the window labelled 'main': a window-* window owns sessions too",
  );
  assert.match(
    main,
    /^\s*setupConnectionsWindowBridge\(\);$/m,
    'main.ts has to register the bridge for every window it initialises',
  );
});

// ── 2. Which window may act on a request ──

test('a request names its target, and only that window acts on it', () => {
  const bridge = bodyAfter(read('connections-window.ts'), 'export function setupConnectionsWindowBridge');

  assert.match(
    bridge,
    /payload\?\.targetWindowLabel === thisWindow/,
    'the decision has to be the payload label against this window, in one place',
  );

  for (const event of ['EVENT_OPEN_REQUEST', 'EVENT_NEW_REQUEST']) {
    const at = bridge.indexOf(event);
    assert.ok(at > 0, `${event} must still be served`);
    const handler = bridge.slice(at, bridge.indexOf('});', at));
    assert.ok(
      handler.includes('if (!isForThisWindow('),
      `${event} must return early when it is addressed elsewhere, or every open window answers it`,
    );
  }
});

test('a mutation stays a broadcast, unlike a request', () => {
  const bridge = bodyAfter(read('connections-window.ts'), 'export function setupConnectionsWindowBridge');
  const mutated = bridge.slice(bridge.indexOf('EVENT_MUTATED'));

  assert.ok(
    !mutated.includes('isForThisWindow'),
    'an edit made in the launcher is news for every window, not a request for one',
  );
  assert.ok(
    mutated.includes("'ssh-connections-changed'") && mutated.includes("'remote-connections-changed'"),
    'the broadcast has to reach the listeners the home view already has',
  );
});

// ── 3. Which window the launcher belongs to ──

test('the launcher is claimed before it is created, and told when it is reused', () => {
  const open = bodyAfter(read('connections-window.ts'), 'export async function openConnectionsWindow');

  const claim = open.indexOf('claimConnectionsWindowOwner(');
  assert.ok(claim > 0, 'the opener has to record itself as the owner');
  assert.ok(
    claim < open.indexOf('WebviewWindow.getByLabel('),
    'the claim has to precede both the lookup and the creation: a window that is being created reads the store while it initialises',
  );
  assert.match(
    open,
    /emitTo\(CONNECTIONS_WINDOW_LABEL, EVENT_OWNER_CLAIM, \{ owner \}\)/,
    'an already-open launcher has read its owner and has to be told about the takeover',
  );
});

test('the launcher sends its requests to that window', () => {
  const source = read('connections-window.ts');
  const sender = bodyAfter(source, 'function emitToOwner');

  assert.match(
    sender,
    /invoke<string \| null>\('connections_dispatch', \{ request \}\)/,
    'requests must pass through the constrained native dispatcher',
  );

  for (const site of [
    'emitToOwner(EVENT_OPEN_REQUEST',
    'emitToOwner(EVENT_NEW_REQUEST',
  ]) {
    assert.ok(source.includes(site), `every request has to go through the sender: ${site} is missing`);
  }
  assert.ok(
    !/void emit\(EVENT_(OPEN|NEW)_REQUEST/.test(source),
    'a request must never be broadcast again — that is the bug this file exists for',
  );
});

test('a launcher that has never been told falls back to the startup window', () => {
  const init = bodyAfter(read('connections-window.ts'), 'export function initConnectionsWindow');

  assert.ok(
    init.includes('ownerWindowLabel = readStoredOwner() ?? PRIMARY_WINDOW_LABEL'),
    'a launcher that outlived its opener still has to open sessions somewhere',
  );
  assert.ok(
    init.includes('EVENT_OWNER_CLAIM'),
    'the launcher has to listen for a takeover, not only read the store once',
  );
});

test('a label that cannot be a window of this app is never a target', () => {
  const source = read('connections-window.ts');
  const usable = bodyAfter(source, 'function usableOwnerLabel');

  assert.ok(
    usable.includes('value === CONNECTIONS_WINDOW_LABEL'),
    'a launcher that owned itself would send every request into the void',
  );
  assert.ok(
    usable.includes('WINDOW_LABEL_PATTERN'),
    'only Tauri label characters may be addressed',
  );
  assert.ok(
    source.includes('const WINDOW_LABEL_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/;'),
    'the pattern itself is the contract — Tauri labels are a-zA-Z-/:_ and stay well under 64 characters',
  );
});

// ── 4. The events the fix relies on stay permitted ──
//
// Both `emit` and `emitTo` are gated by the window capability, and the grant lives
// in a different file from the call. A missing one fails at runtime as a rejected
// promise — the launcher button just looks dead, and neither `tsc` nor a source
// test over `src/` would notice. The launcher now *targets* its requests, so both
// windows that take part have to be allowed to.

test('both windows that target a request are allowed to', () => {
  const launcher = JSON.parse(readCapability('connections.json'));
  assert.ok(!launcher.permissions.includes('core:event:allow-emit'));
  assert.ok(!launcher.permissions.includes('core:event:allow-emit-to'));
  assert.ok(launcher.permissions.includes('connections-commands'));
  assert.match(read('connections-window.ts'), /invoke\(['"]connections_dispatch['"]/);
  // The whole fix rests on a `window-*` window being able to serve the launcher, so
  // "new window" has to stay covered by the capability that grants it the API.
  const covered: string[] = JSON.parse(readCapability('default.json')).windows;
  assert.ok(
    covered.includes('window-*') && covered.includes('main'),
    'every window that can own the launcher has to be covered by a capability',
  );
});

test('native dispatcher permits only connection events and checks live owner before delivery', () => {
  const rust = fs.readFileSync(new URL('../src-tauri/src/commands/connections_dispatch.rs', import.meta.url), 'utf8');
  assert.match(rust, /caller\.label\(\)\s*!=\s*"connections"/);
  assert.match(rust, /get_webview_window\(preferred_owner\)/);
  assert.match(rust, /get_webview_window\("main"\)/);
  for (const event of ['connections-open-request', 'connections-new-request', 'connections-mutated']) {
    assert.ok(rust.includes(event));
  }
  assert.doesNotMatch(rust, /pub async fn connections_dispatch[^]*event:\s*String/);
});
