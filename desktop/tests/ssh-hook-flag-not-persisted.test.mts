import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { toSavedConnection, toSSHConnectionConfig } from '../src/connection-sync.ts';

/**
 * `ssh.ts` cannot be imported here: it pulls in the extensionless frontend
 * graph (`./i18n`, Tauri plugins, …), which Node's ESM resolver refuses.
 * Slice the two functions that decide what a saved record may contain and
 * run them against a stub localStorage instead.
 */
function sourceOf(file: string, name: string): string {
  const path = new URL(`../src/${file}`, import.meta.url);
  const parsed = ts.createSourceFile(file, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return ts.transpile(statement.getText(parsed).replace('export ', ''), { target: ts.ScriptTarget.ES2021 });
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
          return ts.transpile(statement.getText(parsed), { target: ts.ScriptTarget.ES2021 });
        }
      }
    }
  }
  assert.fail(`${name} not found in ${file}`);
}

/** The real normalizer + reader from ssh.ts, bound to a fake localStorage. */
function loadSaved(stored: unknown) {
  const store = new Map<string, string>([['meterm-ssh-connections', JSON.stringify(stored)]]);
  const localStorageStub = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
  const factory = new Function(
    'localStorage', 'JSON',
    `${sourceOf('ssh.ts', 'SSH_CONNECTIONS_KEY')}
     ${sourceOf('ssh.ts', 'stripRuntimeOnlyFields')}
     ${sourceOf('ssh.ts', 'loadSavedConnections')}
     return { loadSavedConnections, stripRuntimeOnlyFields };`,
  );
  return factory(localStorageStub, JSON) as {
    loadSavedConnections: () => Array<Record<string, unknown>>;
    stripRuntimeOnlyFields: (config: Record<string, unknown>) => Record<string, unknown>;
  };
}

test('a saved record that carries skipShellHook no longer overrides the setting', () => {
  // The bug: handleSSHConnect() derives skipShellHook from the global hook
  // toggle, addConnection() persisted that derived value, and the connect
  // form only ever prefilled from the record — so an entry saved while the
  // toggle was off could never get the hook again, with no UI to clear it.
  const { loadSavedConnections } = loadSaved([
    { name: '192.168.200.219', host: '192.168.200.219', username: 'mj', skipShellHook: true },
    { name: '192.168.100.211', host: '192.168.100.211', username: 'mj', skipShellHook: false },
  ]);

  for (const record of loadSavedConnections()) {
    assert.equal(record.skipShellHook, undefined, 'the derived flag must not survive the read');
  }
});

test('normalizing drops only the derived flag and keeps the rest of the record', () => {
  const { stripRuntimeOnlyFields } = loadSaved([]);
  const input = {
    name: 'prod', host: 'prod.example.com', port: 2222, username: 'deploy',
    authMethod: 'key', skipShellHook: true, multiplexSftp: true, privateKey: '~/.ssh/id_ed25519',
  };

  assert.deepEqual(stripRuntimeOnlyFields(input), {
    name: 'prod', host: 'prod.example.com', port: 2222, username: 'deploy',
    authMethod: 'key', multiplexSftp: true, privateKey: '~/.ssh/id_ed25519',
  });
  assert.equal(input.skipShellHook, true, 'the input object must not be mutated');
});

test('a malformed saved-connection list reads as empty instead of throwing', () => {
  const store = new Map<string, string>([['meterm-ssh-connections', '{"nope":1}']]);
  const factory = new Function(
    'localStorage', 'JSON',
    `${sourceOf('ssh.ts', 'SSH_CONNECTIONS_KEY')}
     ${sourceOf('ssh.ts', 'stripRuntimeOnlyFields')}
     ${sourceOf('ssh.ts', 'loadSavedConnections')}
     return loadSavedConnections();`,
  );
  assert.deepEqual(
    factory({ getItem: (k: string) => store.get(k) ?? null }, JSON),
    [],
  );
});

test('a cloud copy of skip_shell_hook is ignored when pulling a connection', () => {
  // connection-sync used to apply the server's value, which resurrected the
  // stale `true` even after the local record had been cleaned.
  const pulled = toSSHConnectionConfig({
    id: 'id-1', name: 'prod', host: 'prod.example.com', port: 22, username: 'deploy',
    auth_method: 'key', has_key_path: false, updated_at: 1, deleted_at: null,
    skip_shell_hook: true, multiplex_sftp: true,
  });

  assert.equal(pulled.skipShellHook, undefined);
  assert.equal(pulled.multiplexSftp, true, 'unrelated metadata still round-trips');
});

test('the push payload still carries the field for wire compatibility', () => {
  // toSavedConnection() derives the registry id through localStorage.
  const store = new Map<string, string>();
  const previous = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  try {
    const payload = toSavedConnection({
      name: 'prod', host: 'prod.example.com', port: 22, username: 'deploy',
      authMethod: 'password', skipShellHook: true,
    });

    assert.equal(payload.skip_shell_hook, true);
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = previous;
  }
});
