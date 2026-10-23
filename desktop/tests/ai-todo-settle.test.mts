import assert from 'node:assert/strict';
import test from 'node:test';
import { TodoState } from '../src/ai-tools-todo.ts';

const item = (id: string, status: 'pending' | 'in_progress' | 'completed') =>
  ({ id, content: id, activeForm: id, status });

test('a final reply completes the last step left in progress', () => {
  const state = new TodoState();
  state.set([item('a', 'completed'), item('b', 'completed'), item('c', 'in_progress')]);
  state.settleAfterReply();
  assert.deepEqual(state.get().map(i => i.status), ['completed', 'completed', 'completed']);
});

test('a reply mid-plan stops the spinner without completing the step', () => {
  const state = new TodoState();
  state.set([item('a', 'completed'), item('b', 'in_progress'), item('c', 'pending')]);
  state.settleAfterReply();
  assert.deepEqual(state.get().map(i => i.status), ['completed', 'pending', 'pending']);
});

test('settling a plan with nothing in progress changes nothing', () => {
  const state = new TodoState();
  let updates = 0;
  state.set([item('a', 'completed'), item('b', 'pending')]);
  state.onUpdate = () => { updates++; };
  state.settleAfterReply();
  assert.equal(updates, 0);
  assert.deepEqual(state.get().map(i => i.status), ['completed', 'pending']);
});
