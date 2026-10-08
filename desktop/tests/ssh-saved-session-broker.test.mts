import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/ssh-saved-session.ts', import.meta.url), 'utf8');

function harness(saved: Record<string, unknown>) {
  const exports: Record<string, (...args: any[]) => any> = {};
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const raw: string[] = [];
  const context = {
    exports,
    require: (path: string) => {
      if (path === './ssh') return {
        loadSavedConnections: () => [saved],
        isInlinePrivateKey: (value: string) => value.includes('\n') || value.trimStart().startsWith('-----BEGIN '),
        createSSHSession: async () => { raw.push('connect'); return 'raw-session'; },
        testSSHConnection: async () => { raw.push('test'); return { ok: true }; },
        showHostKeyConfirmDialog: async () => false,
      };
      if (path === './connection-sync') return { existingConnectionId: () => 'saved-id' };
      if (path === './i18n') return { t: (key: string) => key };
      throw new Error(`unexpected import ${path}`);
    },
    fetch: async (url: string, init: { body: string }) => {
      requests.push({ path: url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ id: 'saved-session', ok: true }) };
    },
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, context);
  return { api: exports, requests, raw };
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
