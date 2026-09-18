import assert from 'node:assert/strict';
import test from 'node:test';
import { abortableOperation } from '../src/ai-abortable-operation.ts';
import { TodoState } from '../src/ai-tools-todo.ts';
import { isTerminalInterruption } from '../src/ai-terminal-interruption.ts';

test('cancel settles even when provider never calls completion or error', async () => {
  const ctl = new AbortController();
  let lateComplete: (value: string) => void = () => {};
  const pending = abortableOperation<string>(ctl.signal, resolve => { lateComplete = resolve; });
  ctl.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  lateComplete('ignored');
});
test('already aborted request does not start provider', async () => {
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(abortableOperation(ctl.signal, () => assert.fail('started')), { name: 'AbortError' });
});
test('normal provider result and errors remain unchanged', async () => {
  const ctl = new AbortController();
  assert.equal(await abortableOperation(ctl.signal, resolve => resolve('ok')), 'ok');
  await assert.rejects(abortableOperation(ctl.signal, () => { throw new Error('failed'); }), /failed/);
  ctl.abort();
});
test('interruption clears active plan state without marking unfinished items complete', () => {
  const state = new TodoState();
  state.set(['completed', 'in_progress', 'pending'].map((status, i) => ({ id: String(i), content: 'task', activeForm: 'working', status: status as any })));
  let updates = 0; state.onUpdate = () => updates++;
  state.interrupt(); state.interrupt();
  assert.deepEqual(state.get().map(item => item.status), ['completed', 'interrupted', 'pending']);
  assert.equal(updates, 1);
  assert.match(state.renderForSystemPrompt(), /\[interrupted\]/);
  assert.match(state.renderForSystemPrompt(), /0 in progress/);
});
test('manual SIGINT terminates agent continuation, not arbitrary failed commands', () => {
  assert.ok(isTerminalInterruption('run_command', '[status: completed, elapsed: 1s, exit: 130]\n'));
  assert.ok(isTerminalInterruption('watch_terminal', '[Pane 1]\n[status: completed, elapsed: 1s, exit: 130]\n'));
  for (const exit of [0, 1, 1300]) assert.equal(isTerminalInterruption('run_command', `[status: completed, exit: ${exit}]`), false);
  assert.equal(isTerminalInterruption('read_file', '[status: completed, exit: 130]'), false);
});
