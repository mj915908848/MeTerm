import assert from 'node:assert/strict';
import test from 'node:test';
import { TransferStore, TRANSFER_STORAGE_KEY, STALE_ACTIVE_MS, MAX_TRANSFER_RECORDS } from '../src/file-transfer-store.ts';

function memory(initial: unknown[] = []) {
  const data = new Map<string, string>([[TRANSFER_STORAGE_KEY, JSON.stringify(initial)]]);
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    stored: () => JSON.parse(data.get(TRANSFER_STORAGE_KEY)!) as any[],
  };
}
const record = (id: string, status = 'completed', timestamp = 1, extra: object = {}): any =>
  ({ id, type: 'upload', filename: id, path: `/${id}`, size: 1, progress: 0, status, timestamp, ...extra });

test('two windows saving keep each other\'s records', () => {
  const storage = memory();
  let clock = 1000;
  const a = new TransferStore(storage, () => 'interrupted', () => clock);
  const b = new TransferStore(storage, () => 'interrupted', () => clock);
  a.add(record('a1', 'pending', 1));
  b.add(record('b1', 'pending', 2));
  a.invalidate();
  a.find('a1')!.status = 'completed';
  a.save();
  assert.deepEqual(storage.stored().map(r => r.id).sort(), ['a1', 'b1']);
  assert.equal(storage.stored().find(r => r.id === 'a1').status, 'completed');
});

test('a transfer running in another window is not marked interrupted while its heartbeat is fresh', () => {
  const storage = memory();
  let clock = 1000;
  const owner = new TransferStore(storage, () => 'interrupted', () => clock);
  owner.add(record('run', 'inprogress', 1));
  const viewer = new TransferStore(storage, () => 'interrupted', () => clock + 1000);
  assert.equal(viewer.find('run')!.status, 'inprogress');
  viewer.save();
  assert.equal(storage.stored()[0].status, 'inprogress');
});

test('an abandoned active record from a previous run shows and saves as interrupted', () => {
  const storage = memory([record('old', 'inprogress', 1, { heartbeat: 1 })]);
  const store = new TransferStore(storage, () => 'interrupted', () => 1 + STALE_ACTIVE_MS + 1);
  assert.equal(store.find('old')!.status, 'failed');
  assert.equal(store.find('old')!.error, 'interrupted');
  store.add(record('new', 'pending', 2));
  assert.equal(storage.stored().find(r => r.id === 'old').status, 'failed');
});

test('removal sticks even when another window still lists the record', () => {
  const storage = memory([record('x'), record('y', 'completed', 2)]);
  const store = new TransferStore(storage, () => 'i', () => 0);
  store.remove(['x']);
  storage.setItem(TRANSFER_STORAGE_KEY, JSON.stringify([record('x'), record('y', 'completed', 2)]));
  store.invalidate();
  assert.deepEqual(store.list().map(r => r.id), ['y']);
});

test('the list is newest first, capped, and tolerates corrupt storage', () => {
  const many = Array.from({ length: MAX_TRANSFER_RECORDS + 10 }, (_, i) => record(`r${i}`, 'completed', i));
  const store = new TransferStore(memory(many), () => 'i', () => 0);
  assert.equal(store.list().length, MAX_TRANSFER_RECORDS);
  assert.equal(store.list()[0].id, `r${MAX_TRANSFER_RECORDS + 9}`);
  const broken = { getItem: () => '{not json', setItem: () => {} };
  assert.deepEqual(new TransferStore(broken, () => 'i').list(), []);
});
