import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = (name: string) => fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('connection change notifications refresh while a terminal is active', () => {
  const source = read('event-listeners.ts');
  const handlers = source.slice(source.indexOf('  // SSH connections changed'), source.indexOf('  // Remote connect from home page button'));
  assert.ok(handlers.includes('ssh-connections-changed'));
  const listeners = new Map<string, () => void>();
  let refreshes = 0;
  vm.runInNewContext(handlers, {
    isHomeView: false,
    document: { addEventListener: (name: string, cb: () => void) => listeners.set(name, cb) },
    updateSSHHomeView: () => { refreshes++; },
  });
  listeners.get('ssh-connections-changed')!();
  assert.equal(refreshes, 1);
  listeners.get('remote-connections-changed')!();
  assert.equal(refreshes, 2);
});

function deletionHarness(reject = false) {
  const source = read('home-dashboard-left.ts');
  const start = source.indexOf('async function handleDeleteConnection(');
  const end = source.indexOf('// ─── Helpers', start);
  assert.ok(start >= 0 && end > start);
  const calls: string[] = [];
  const toasts: { title: string; body: string }[] = [];
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const context = vm.createContext({
    removeSSHConnection: async () => {
      await gate;
      if (reject) throw new Error('delete failed');
      calls.push('deleted');
    },
    removeConnectionGroup: () => calls.push('group removed'),
    // i18n keys come back verbatim so the assertions can name the key itself.
    t: (key: string) => key,
    showToast: (opts: { title: string; body: string }) => toasts.push(opts),
  });
  vm.runInContext(ts.transpileModule(source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  const pending = context.handleDeleteConnection(
    { type: 'ssh', key: 'ssh:test', raw: { name: 'test' } },
    () => calls.push('refreshed'),
  ) as Promise<void>;
  return { calls, toasts, finish, pending };
}

test('SSH deletion refreshes only after the credential and metadata deletion completes', async () => {
  const h = deletionHarness();
  assert.deepEqual(h.calls, []);
  h.finish();
  await h.pending;
  assert.deepEqual(h.calls, ['deleted', 'group removed', 'refreshed']);
  assert.deepEqual(h.toasts, []);
});

test('failed SSH deletion preserves grouping and does not report a refreshed deletion', async () => {
  const h = deletionHarness(true);
  const rejection = assert.rejects(h.pending, /delete failed/);
  h.finish();
  await rejection;
  assert.deepEqual(h.calls, []);
  // …but it must be visible: a silent failure reads as a dead button.
  assert.deepEqual(h.toasts.map((toast) => toast.title), ['connectionDeleteFailedTitle']);
});

function removeConnectionHarness(deleteFails: boolean) {
  const source = read('ssh.ts');
  const start = source.indexOf('export async function removeConnection(');
  assert.ok(start >= 0);
  const body = source.slice(start, source.indexOf('\n}', start) + 2).replace('export ', '');
  const warnCalls: unknown[][] = [];
  const stored = new Map<string, string>();
  const spoken: string[] = [];
  const context = vm.createContext({
    loadSavedConnections: () => [{ name: 'alpha' }, { name: 'beta' }],
    SSH_CONNECTIONS_KEY: 'ssh-connections',
    console: { warn: (...args: unknown[]) => warnCalls.push(args) },
    localStorage: { setItem: (key: string, value: string) => { stored.set(key, value); spoken.push(key); } },
    syncDelete: async (name: string) => {
      if (deleteFails) throw new Error('stale SSH connection delete');
      spoken.push(`synced:${name}`);
    },
  });
  vm.runInContext(ts.transpileModule(body, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  const pending = (context.removeConnection as (name: string) => Promise<void>)('alpha');
  return { pending, warnCalls, stored, spoken };
}

test('a failing sync soft delete still removes the connection locally', async () => {
  const h = removeConnectionHarness(true);
  await h.pending;
  assert.deepEqual(h.spoken, ['ssh-connections']);
  assert.deepEqual(JSON.parse(h.stored.get('ssh-connections')!), [{ name: 'beta' }]);
  assert.equal(h.warnCalls.length, 1);
  assert.match(String(h.warnCalls[0][0]), /sync delete failed/);
});

test('a successful sync soft delete removes the connection without warning', async () => {
  const h = removeConnectionHarness(false);
  await h.pending;
  assert.deepEqual(h.spoken, ['synced:alpha', 'ssh-connections']);
  assert.deepEqual(JSON.parse(h.stored.get('ssh-connections')!), [{ name: 'beta' }]);
  assert.deepEqual(h.warnCalls, []);
});
