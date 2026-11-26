import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/ssh-saved-session.ts', import.meta.url), 'utf8');

function harness(saved: Record<string, unknown>, options: {
  challenges?: Record<string, unknown>[];
  accept?: boolean;
  canReplace?: boolean;
} = {}) {
  const exports: Record<string, (...args: any[]) => any> = {};
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const raw: string[] = [];
  const confirmations: unknown[][] = [];
  const challenges = [...(options.challenges ?? [])];
  const context = {
    exports,
    require: (path: string) => {
      if (path === './ssh') return {
        loadSavedConnections: () => [saved],
        isInlinePrivateKey: (value: string) => value.includes('\n') || value.trimStart().startsWith('-----BEGIN '),
        createSSHSession: async () => { raw.push('connect'); return 'raw-session'; },
        testSSHConnection: async () => { raw.push('test'); return { ok: true }; },
        canReplaceSSHHostKey: () => options.canReplace ?? true,
        showHostKeyConfirmDialog: async (...args: unknown[]) => {
          confirmations.push(args);
          return options.accept ?? false;
        },
      };
      if (path === './connection-sync') return { existingConnectionId: () => 'saved-id' };
      if (path === './i18n') return { t: (key: string) => key };
      throw new Error(`unexpected import ${path}`);
    },
    fetch: async (url: string, init: { body: string }) => {
      requests.push({ path: url, body: JSON.parse(init.body) });
      const challenge = challenges.shift();
      return { ok: !challenge, json: async () => challenge ?? { id: 'saved-session', ok: true } };
    },
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, context);
  return { api: exports, requests, raw, confirmations };
}

const saved = {
  name: 'production', serverConnectionId: 'saved-id', host: 'prod.example.com',
  port: 22, username: 'deploy', authMethod: 'key', privateKey: '~/.ssh/id_ed25519',
  proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: 1080, proxyUsername: 'proxy-user',
};

test('saved key path uses vault-backed connect and test routes', async () => {
  const h = harness(saved);
  const config = { ...saved, skipShellHook: true };
  assert.equal(h.api.shouldUseSavedSessionBroker(config), true);
  assert.equal(await h.api.createSSHSessionForConfig(config, 51766, 'token'), 'saved-session');
  const testResult = await h.api.testSSHConnectionForConfig(config, 51766, 'token');
  assert.equal(testResult.ok, true);
  assert.equal(testResult.error, undefined);
  assert.equal(h.raw.length, 0);
  assert.equal(h.requests.length, 2);
});

test('a newly entered key path never substitutes the saved vault credential', async () => {
  const h = harness(saved);
  const config = { ...saved, privateKey: '~/.ssh/other_key' };
  assert.equal(h.api.shouldUseSavedSessionBroker(config), false);
  assert.equal(await h.api.createSSHSessionForConfig(config, 51766, 'token'), 'raw-session');
  assert.deepEqual(h.raw, ['connect']);
  assert.equal(h.requests.length, 0);
});

test('saved connect posts current shell-hook choice, including false', async () => {
  const h = harness(saved);
  await h.api.createSSHSessionForConfig({ ...saved, skipShellHook: true }, 51766, 'token');
  await h.api.createSSHSessionForConfig({ ...saved, skipShellHook: false }, 51766, 'token');
  assert.deepEqual(h.requests.map(({ body }) => body.skip_shell_hook), [true, false]);
});

test('a stale registry id from the recent list resolves to the saved endpoint', async () => {
  // Recent entries can carry an id from another build or an older registry.
  const h = harness(saved);
  const recent = { ...saved, serverConnectionId: 'stale-id', privateKey: undefined };
  assert.equal(h.api.shouldUseSavedSessionBroker(recent), true);
  assert.equal(await h.api.createSSHSessionForConfig(recent, 51766, 'token'), 'saved-session');
  assert.equal(h.requests[0].body.id, 'saved-id');
  assert.equal(h.raw.length, 0);
});

test('a stale id never borrows a saved connection for a different endpoint', async () => {
  const h = harness(saved);
  const other = { ...saved, serverConnectionId: 'stale-id', host: 'other.example.com' };
  assert.equal(h.api.shouldUseSavedSessionBroker(other), false);
  assert.equal(await h.api.createSSHSessionForConfig(other, 51766, 'token'), 'raw-session');
  assert.equal(h.requests.length, 0);
});

const changedKey = {
  error: 'host_key_mismatch',
  hostname: 'prod.example.com:22',
  fingerprint: 'new-fingerprint',
  key_type: 'ssh-ed25519',
};

test('confirmed changed host key retries connect and test with the displayed fingerprint', async () => {
  for (const operation of ['createSSHSessionForConfig', 'testSSHConnectionForConfig']) {
    const h = harness(saved, { challenges: [changedKey], accept: true });
    await h.api[operation](saved, 51766, 'token');
    assert.deepEqual(h.confirmations, [[changedKey.hostname, changedKey.fingerprint, changedKey.key_type, true]]);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[0].body.replace_host_key, false);
    assert.equal(h.requests[1].body.replace_host_key, true);
    assert.equal(h.requests[1].body.trusted_fingerprint, changedKey.fingerprint);
    assert.equal(h.requests[1].path, h.requests[0].path);
  }
});

test('cancelling a changed key leaves the saved trust alone', async () => {
  const h = harness(saved, { challenges: [changedKey] });
  await assert.rejects(h.api.createSSHSessionForConfig(saved, 51766, 'token'), /cancelled/);
  assert.equal(h.requests.length, 1);
});

test('a changed key is rejected if it changes again during the pinned retry', async () => {
  const h = harness(saved, {
    challenges: [changedKey, { ...changedKey, fingerprint: 'different-again' }],
    accept: true,
  });
  await assert.rejects(h.api.createSSHSessionForConfig(saved, 51766, 'token'), /sshHostKeyMismatchMsg/);
  assert.equal(h.requests.length, 2);
  assert.equal(h.confirmations.length, 1);
});

test('the normal first-trust flow does not request host key replacement', async () => {
  const h = harness(saved, {
    challenges: [{ ...changedKey, error: 'host_key_unknown' }],
    accept: true,
  });
  await h.api.createSSHSessionForConfig(saved, 51766, 'token');
  assert.equal(h.confirmations[0][3], false);
  assert.equal(h.requests[1].body.replace_host_key, false);
  assert.equal(h.requests[1].body.trusted_fingerprint, changedKey.fingerprint);
});

test('changed-key confirmation is unavailable on other platforms', async () => {
  const h = harness(saved, { challenges: [changedKey], canReplace: false });
  await assert.rejects(h.api.createSSHSessionForConfig(saved, 51766, 'token'), /sshHostKeyMismatchMsg/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.confirmations.length, 0);
});
