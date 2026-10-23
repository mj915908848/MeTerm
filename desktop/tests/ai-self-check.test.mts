import assert from 'node:assert/strict';
import test from 'node:test';
import { newSelfCheckState, noteToolCall, selfCheckNote } from '../src/ai-self-check.ts';

test('no note when nothing changed and the plan is done', () => {
  const s = newSelfCheckState();
  noteToolCall(s, 'run_command', false, false);
  assert.equal(selfCheckNote(s, [], 'All good.', true), null);
});

test('an unverified change gets one note, then the run may end', () => {
  const s = newSelfCheckState();
  noteToolCall(s, 'edit_file', true, false);
  const note = selfCheckNote(s, [], 'Done, nginx now listens on 8080.', true);
  assert.match(note ?? '', /has not been checked/);
  s.nudged = true;
  assert.equal(selfCheckNote(s, [], 'Done.', true), null);
});

test('a read-only command after the change counts as a check', () => {
  const s = newSelfCheckState();
  noteToolCall(s, 'edit_file', true, false);
  noteToolCall(s, 'run_command', false, false);
  assert.equal(selfCheckNote(s, [], 'Done.', true), null);
});

test('failed calls and non-terminal tools leave the state alone', () => {
  const s = newSelfCheckState();
  noteToolCall(s, 'write_file', true, true);
  assert.equal(s.unverifiedChange, false);
  noteToolCall(s, 'edit_file', true, false);
  noteToolCall(s, 'todo_write', false, false);
  assert.equal(s.unverifiedChange, true);
});

test('open plan steps are listed', () => {
  const s = newSelfCheckState();
  const note = selfCheckNote(s, ['Restart nginx', 'Check the site'], 'Done.', true);
  assert.match(note ?? '', /- Restart nginx\n {2}- Check the site/);
});

test('no note when the reply asks the user something or no steps are left', () => {
  const s = newSelfCheckState();
  noteToolCall(s, 'edit_file', true, false);
  assert.equal(selfCheckNote(s, ['x'], 'Should I restart nginx now?', true), null);
  assert.equal(selfCheckNote(s, ['x'], '要现在重启吗？', true), null);
  assert.equal(selfCheckNote(s, ['x'], 'Done.', false), null);
});
