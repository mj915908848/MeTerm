import assert from 'node:assert/strict';
import test from 'node:test';

const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, v); },
};
const notes = await import('../src/ai-host-notes.ts');

test('host key drops the user and lowercases; local panes share one key', () => {
  assert.equal(notes.hostNotesKey(true, 'root@Web-1.example.com:22'), 'web-1.example.com:22');
  assert.equal(notes.hostNotesKey(true, 'deploy@web-1.example.com:22'), 'web-1.example.com:22');
  assert.equal(notes.hostNotesKey(false, null), 'local');
  assert.equal(notes.hostNotesKey(true, ''), null);
});

test('notes are saved, appended as bullets, listed newest first and deleted when empty', () => {
  memory.clear();
  notes.setHostNotes('a:22', notes.appendedHostNotes('', 'app in /srv/app'), 1);
  notes.setHostNotes('a:22', notes.appendedHostNotes(notes.getHostNotes('a:22'), 'restart:\nsystemctl restart app'), 2);
  notes.setHostNotes('b:22', '- nginx only', 3);
  assert.equal(notes.getHostNotes('a:22'), '- app in /srv/app\n- restart: systemctl restart app');
  assert.deepEqual(notes.listHostNotes().map((n) => n.key), ['b:22', 'a:22']);
  notes.setHostNotes('b:22', '  ');
  assert.deepEqual(notes.listHostNotes().map((n) => n.key), ['a:22']);
});

test('over-long notes are refused and corrupt storage reads as empty', () => {
  assert.throws(() => notes.setHostNotes('a:22', 'x'.repeat(notes.HOST_NOTES_MAX_CHARS + 1)), /limit/);
  memory.set('meterm-host-notes', '{not json');
  assert.deepEqual(notes.listHostNotes(), []);
});
