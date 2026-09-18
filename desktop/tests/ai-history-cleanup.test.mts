import assert from 'node:assert/strict';
import test from 'node:test';
import { bindLegacyHistory, deleteHistoryFiles } from '../src/ai-conversation-binding-store.ts';

function fixture() {
  const path = 'chat-history/example.json';
  const original = JSON.stringify({ id: 'example', messages: [] });
  const files = new Map([[path, original], [path + '.pre-host-binding.bak', original], [path + '.binding.tmp', 'partial'], ['chat-history/other.json', 'other']]);
  const storage = {
    read: async (p: string) => files.get(p)!,
    write: async (p: string, data: string) => { files.set(p, data); },
    exists: async (p: string) => files.has(p),
    remove: async (p: string) => { files.delete(p); },
    rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
  };
  return { path, original, files, storage };
}
test('deletion removes only the selected primary and known sidecars and is idempotent', async () => {
  const { files, storage } = fixture();
  await deleteHistoryFiles('example', storage);
  assert.deepEqual([...files.keys()], ['chat-history/other.json']);
  await deleteHistoryFiles('example', storage);
});
test('deletion can clean sidecars when the primary is already absent', async () => {
  const { path, files, storage } = fixture(); files.delete(path);
  await deleteHistoryFiles('example', storage); assert.equal(files.size, 1);
});
test('invalid identifiers never touch storage or resolve to another conversation', async () => {
  for (const id of ['../example', 'example/', '', 'example.json']) {
    await assert.rejects(deleteHistoryFiles(id, { exists: async () => assert.fail(), remove: async () => assert.fail() }), /Invalid/);
  }
});
test('primary deletion failure preserves backup and temporary file', async () => {
  const { path, files, storage } = fixture();
  await assert.rejects(deleteHistoryFiles('example', { ...storage, remove: async () => { throw new Error('permission'); } }), /permission/);
  assert.equal(files.has(path), true); assert.equal(files.has(path + '.pre-host-binding.bak'), true);
  assert.equal(files.has(path + '.binding.tmp'), true);
});
test('sidecar deletion failure still attempts the remaining file and releases operation guard', async () => {
  const { path, files, storage } = fixture();
  await assert.rejects(deleteHistoryFiles('example', { ...storage, remove: async p => {
    if (p.endsWith('.bak')) throw new Error('permission'); await storage.remove(p);
  } }), /sidecar cleanup/);
  assert.equal(files.has(path + '.binding.tmp'), false); assert.equal(files.has(path + '.pre-host-binding.bak'), true);
  await deleteHistoryFiles('example', storage); assert.equal(files.size, 1);
});
test('failed staging write cleans partial temporary data and preserves recovery backup', async () => {
  const { path, original, files, storage } = fixture();
  await assert.rejects(bindLegacyHistory('example', { kind: 'local' }, { ...storage, write: async (p, data) => {
    await storage.write(p, data); throw new Error('disk full');
  } }), /disk full/);
  assert.equal(files.get(path), original); assert.equal(files.get(path + '.pre-host-binding.bak'), original);
  assert.equal(files.has(path + '.binding.tmp'), false);
});
test('delete cannot race an in-progress binding in the same window', async () => {
  const { files, storage } = fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = bindLegacyHistory('example', { kind: 'local' }, { ...storage, read: async p => { await gate; return storage.read(p); } });
  await assert.rejects(deleteHistoryFiles('example', storage), /in progress/);
  release(); await pending; await deleteHistoryFiles('example', storage); assert.equal(files.size, 1);
});
