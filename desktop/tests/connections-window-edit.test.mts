/**
 * How the connection window edits a connection.
 *
 * Editing used to be delegated to the main window: this window emitted
 * `connections-edit-request` and the main window ran `show() + setFocus()` before
 * opening the dialog. When the main window is full-screen it owns its own macOS
 * Space, so focusing it switched Spaces and the connection list disappeared.
 *
 * So the edit dialog runs *here*, in the list the user is working in, and only a
 * dialog's "connect" outcome travels on — a session belongs to the main window.
 *
 * Two properties are load-bearing and easy to break:
 *
 *   1. Only `{type, key}` may cross a window boundary. A key is *derived* from
 *      user-editable fields, so it moves when they do; anything acting on the
 *      edited connection has to re-resolve it rather than reuse the key it saw.
 *   2. This window may not start a session, so its ACL may not grant a session
 *      command. A missing Tauri command is rejected silently — no error reaches
 *      the page — which is why the classification below is exhaustive rather than
 *      a spot check.
 *   3. A save has to reach the list that opened the dialog. The store is shared
 *      between windows but the DOM is not, and the dialogs' own
 *      `*-connections-changed` announcement is a `document` event that only a
 *      window running `setupDomEventListeners` — never this one — hears.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const readPermissionSet = (): string =>
  fs.readFileSync(new URL('../src-tauri/permissions/connections-commands.toml', import.meta.url), 'utf8');

/** Slice from `marker` up to the first top-level closing brace line. */
function bodyAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} was not found`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `${marker} has no end`);
  return source.slice(start, end);
}

/** `commands.allow` as declared to the Tauri ACL. */
function grantedCommands(): string[] {
  const toml = readPermissionSet();
  const key = toml.indexOf('commands.allow');
  assert.ok(key >= 0, 'connections-commands.toml must declare commands.allow');
  const open = toml.indexOf('[', key);
  const close = toml.indexOf(']', open);
  const names = [...toml.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 0, 'the permission set must grant at least one command');
  return names;
}

// ── The edit flow runs in this window ──

test('a connection is edited in the connection window, not by the main window', () => {
  const source = read('connections-window.ts');

  assert.match(
    source,
    /import\s*\{[^}]*\beditConnection\b[^}]*\}\s*from\s*'\.\/home-dashboard-left'/,
    'the connection window must run the shared edit flow itself',
  );
  assert.ok(
    source.includes('onEdit: (item) => editConnection(item, afterMutation)'),
    'the row list must edit in place, and refresh the list it was rendered from',
  );
  assert.ok(
    !bodyAfter(source, 'export function setupConnectionsWindowBridge').includes('editConnection'),
    'the main window must not run the edit flow any more — that is what switched Spaces',
  );
});

test('the retired "please edit this" event is gone', () => {
  for (const file of ['connections-window.ts', 'main.ts', 'event-listeners.ts', 'home-dashboard-left.ts']) {
    assert.ok(
      !read(file).includes('connections-edit-request'),
      `${file} still references the retired connections-edit-request event`,
    );
  }
});

// ── What crosses a window boundary ──

test('a delegated connect carries a type and a key, never the connection itself', () => {
  const source = read('connections-window.ts');
  const body = bodyAfter(source, 'function requestConnectInMainWindow');

  assert.ok(body.includes('findConnectionItem('), 'the item must be re-resolved, not passed through');
  assert.match(
    body,
    /emitToOwner\(EVENT_OPEN_REQUEST,\s*\{\s*type:\s*item\.type,\s*key:\s*item\.key\s*\}\)/,
    'only the type and the key may be emitted',
  );

  // The routing label is the one thing the shared sender is allowed to add; a
  // credential smuggled into the payload would have to go through here.
  const sender = bodyAfter(source, 'function emitToOwner');
  assert.match(
    sender,
    /emitTo\(\s*ownerWindowLabel,\s*event,\s*\{\s*\.\.\.payload,\s*targetWindowLabel:\s*ownerWindowLabel\s*\}/,
    'the only field added to a request is the window it is addressed to',
  );

  for (const secret of ['password', 'apiToken', 'privateKey', 'proxyPassword']) {
    assert.ok(
      !source.includes(secret),
      `${secret} must never appear in this window's source: credentials do not cross windows`,
    );
  }
});

test('a rename is safe: the edited item is re-resolved before it is handed on', () => {
  const body = bodyAfter(read('home-dashboard-left.ts'), 'export function editConnection');
  const jump = body.slice(body.indexOf("item.type === 'ssh'"));

  assert.ok(
    jump.indexOf('findConnectionItem(') < jump.indexOf('editConnectDelegate('),
    'a delegate must receive a re-resolved item: renaming a config moves its key',
  );
  assert.ok(
    /editConnectDelegate\(saved\)/.test(jump),
    'the delegate must get the re-resolved item, not the one the row was rendered from',
  );
  assert.ok(
    read('home-dashboard-left.ts').includes('export function setEditConnectDelegate'),
    'the delegate slot has to be installable from the other window',
  );
});

test('every dialog kind hands its connect outcome to the main window', () => {
  const source = read('connections-window.ts');

  // Between one handler and the next, so each is checked on its own instead of
  // matching the neighbouring handler's fields.
  const handlers = ['setSSHConnectHandler(', 'setRemoteConnectHandler(', 'setEditConnectDelegate('];
  for (const marker of handlers) {
    assert.ok(source.includes(marker), `the dialogs need ${marker}`);
  }
  assert.ok(
    source.indexOf(handlers[0]) < source.indexOf(handlers[1]) &&
      source.indexOf(handlers[1]) < source.indexOf(handlers[2]),
    'the handlers must be installed in one place, SSH then remote then JumpServer',
  );

  const ssh = source.slice(source.indexOf(handlers[0]), source.indexOf(handlers[1]));
  // Keyed off the fields the connection's key is built from, which is what keeps
  // the match correct across a rename.
  for (const field of ['saved.name', 'saved.host', 'saved.port']) {
    assert.ok(ssh.includes(field), `the SSH matcher must compare ${field}`);
  }

  const remote = source.slice(source.indexOf(handlers[1]), source.indexOf(handlers[2]));
  for (const field of ['saved.host', 'saved.port']) {
    assert.ok(remote.includes(field), `the remote matcher must compare ${field}`);
  }
  assert.ok(
    !remote.includes('saved.name'),
    'a remote connection has no name of its own — matching on one would never match',
  );
});

// ── The row menu ──

/**
 * The hole this covers: `editConnection` took a `refreshView` and never used it
 * on the SSH and remote branches (only JumpServer returned through it), so saving
 * an edit closed the dialog and left the list rendering the row it was built from
 * — an old name, an old host — until the window was re-focused. The test above
 * could not see it: it checks that `editConnection(item, afterMutation)` is
 * written, and a callback that is passed and never called satisfies that.
 */
test('an SSH or remote save reaches the list that opened the dialog', () => {
  const edit = bodyAfter(read('home-dashboard-left.ts'), 'export function editConnection');

  assert.match(
    edit,
    /showSSHModal\(item\.raw as SSHConnectionConfig,\s*\(\)\s*=>\s*refreshView\(\)\)/,
    'the SSH dialog has to be given a way to say it saved',
  );
  assert.match(
    edit.slice(edit.indexOf("item.type === 'remote'")),
    /showRemoteEditDialog\(item\.raw as RemoteServerInfo,\s*\(\)\s*=>\s*refreshView\(\)\)/,
    'the remote dialog has to be given a way to say it saved',
  );

  // Both SSH buttons save — "save" and "connect and save" — and a callback wired
  // to only one of them is still a list that does not refresh.
  const form = bodyAfter(read('ssh.ts'), 'function createConnectionForm(');
  assert.equal(
    (form.match(/onSaved\?\.\(config\)/g) ?? []).length,
    2,
    'every SSH save path must announce the save, not just the last one written',
  );
  assert.match(
    bodyAfter(read('ssh.ts'), 'export function showSSHModal('),
    /createConnectionForm\(prefill,[\s\S]*?onSaved\)/,
    'showSSHModal has to pass its onSaved through, or the form has nowhere to report',
  );
  assert.ok(
    bodyAfter(read('remote.ts'), 'export function showRemoteEditDialog(').includes('if (onSave) onSave('),
    'the remote dialog already had this hook — it has to keep calling it',
  );
});

test('the row menu offers a plain edit entry, without the dev-only extras', () => {
  const dash = read('home-dashboard-left.ts');
  assert.match(
    dash,
    /export function showConnectionContextMenu\([\s\S]*?onEdit\?:\s*\(\)\s*=>\s*void,/,
    'the menu builder takes an optional edit runner',
  );
  assert.ok(
    /if \(onEdit\) \{[\s\S]{0,400}?onEdit\(\)/.test(dash),
    'when a runner is given, the plain edit item must call it',
  );

  const side = read('home-side.ts');
  assert.ok(
    side.includes('onEdit?: (item: ConnectionItem) => void'),
    'the list must accept an edit runner',
  );
  assert.ok(
    side.includes('deps.onEdit ? () => deps.onEdit!(item) : undefined'),
    'the list must forward its own runner to the menu, or the menu falls back to the dev-only entry',
  );
});

// ── The ACL ──

/** Modules whose behaviour the connection window actually runs. */
const REACHABLE_MODULES = [
  'ssh.ts',
  'remote.ts',
  'remote-storage.ts',
  'jumpserver-ui.ts',
  'jumpserver-api.ts',
  'connection-sync.ts',
] as const;

/**
 * Commands those modules call on paths this window never runs.
 *
 * Every entry needs a reason, because granting it would widen the window's
 * surface for nothing, and forgetting it is a silent rejection.
 */
const NOT_ON_THIS_WINDOWS_PATHS: Readonly<Record<string, string>> = {
  create_ssh_session: 'a session belongs to the main window — see the test below',
  export_ssh_connections: 'reached from the toolbar, the app menu and the settings window',
  remote_list_sessions: 'the session list lives in the main window; the edit dialog never enumerates sessions',
  ping_remote: 'startup pruning of unreachable recents, run by the main window',
  sync_import_named_connection: 'the import flow, run from the settings window or the app menu',
  sync_get_connections: "the main window's startup pull and its 10s poll",
};

function invokesIn(file: string): string[] {
  return [...read(file).matchAll(/invoke(?:<[^>]*>)?\(\s*'([^']+)'/g)].map((m) => m[1]);
}

test('every command the connection window can reach is classified', () => {
  const reached = new Set<string>();
  for (const file of REACHABLE_MODULES) {
    for (const name of invokesIn(file)) reached.add(name);
  }
  // jumpserver-ui.ts reaches the vault through jumpserver-api.ts, so a module with
  // no invoke() of its own is expected. The scan as a whole must not go blind.
  assert.ok(reached.size > 5, 'the scan must cover the window, not a single module');
  for (const file of ['ssh.ts', 'jumpserver-api.ts', 'connection-sync.ts']) {
    assert.ok(invokesIn(file).length > 0, `${file} yielded no invoke() call — the scan has gone blind`);
  }

  const granted = new Set(grantedCommands());
  for (const name of [...reached].sort()) {
    const grantedHere = granted.has(name);
    const excused = Object.hasOwn(NOT_ON_THIS_WINDOWS_PATHS, name);
    assert.ok(
      grantedHere || excused,
      `${name} is reachable from the connection window but is neither granted nor explicitly excused`,
    );
    assert.ok(
      grantedHere !== excused,
      `${name} is both granted and excused — pick one, the excuse is what documents the decision`,
    );
  }

  // A stale excuse silently stops guarding the command it was written for.
  for (const name of Object.keys(NOT_ON_THIS_WINDOWS_PATHS)) {
    assert.ok(reached.has(name), `the excuse for ${name} is stale: nothing calls it any more`);
  }
});

test('the connection window can never start a session', () => {
  const granted = grantedCommands();
  for (const command of ['create_ssh_session', 'create_session', 'ipc_connect_session', 'remote_connect_session']) {
    assert.ok(
      !granted.includes(command),
      `${command} must not be granted: a session belongs to the main window`,
    );
  }

  // Installing the handlers is what keeps the dialogs from falling through to the
  // session-creating path they run in the main window.
  const source = read('connections-window.ts');
  assert.ok(
    source.includes('setSSHConnectHandler('),
    'without the SSH handler the dialog would call createSSHSession in this window',
  );
  assert.ok(
    source.includes('setRemoteConnectHandler('),
    'without the remote handler the dialog would open the session in this window',
  );
});

test("editing a JumpServer config can reach the vault commands that save path needs", () => {
  // Resubmitting secrets stores them; resubmitting nothing asks whether the
  // binding already has one, which is what happens when a user renames a config.
  const api = read('jumpserver-api.ts');
  for (const command of ['jumpserver_store_credentials', 'jumpserver_migrate_credentials']) {
    assert.match(
      api,
      new RegExp(`invoke<[^>]*>\\('${command}'`),
      `${command} must stay on addJumpServerConfig's save path`,
    );
  }

  const granted = grantedCommands();
  for (const command of [
    'jumpserver_store_credentials',
    'jumpserver_migrate_credentials',
    'jumpserver_credential_status',
    'jumpserver_delete_credentials',
  ]) {
    assert.ok(
      granted.includes(command),
      `${command} is on the connection dialog's save path; a missing command is rejected silently`,
    );
  }
});
