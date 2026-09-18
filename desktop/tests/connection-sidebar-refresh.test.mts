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
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const context = vm.createContext({
    removeSSHConnection: async () => {
      await gate;
      if (reject) throw new Error('delete failed');
      calls.push('deleted');
    },
    removeConnectionGroup: () => calls.push('group removed'),
  });
  vm.runInContext(ts.transpileModule(source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  const pending = context.handleDeleteConnection(
    { type: 'ssh', key: 'ssh:test', raw: { name: 'test' } },
    () => calls.push('refreshed'),
  ) as Promise<void>;
  return { calls, finish, pending };
}

test('SSH deletion refreshes only after the credential and metadata deletion completes', async () => {
  const h = deletionHarness();
  assert.deepEqual(h.calls, []);
  h.finish();
  await h.pending;
  assert.deepEqual(h.calls, ['deleted', 'group removed', 'refreshed']);
});

test('failed SSH deletion preserves grouping and does not report a refreshed deletion', async () => {
  const h = deletionHarness(true);
  const rejection = assert.rejects(h.pending, /delete failed/);
  h.finish();
  await rejection;
  assert.deepEqual(h.calls, []);
});
