import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTerminalInput } from '../src/ai-terminal-submit.ts';
import { decideTerminalSubmitPermission, DEFAULT_PERMISSION_RULES } from '../src/ai-permission-rules.ts';

const commandHandler = {
  requiresConfirm: (args: { command: string }) => /\brm\s+-|\bsudo\b/.test(args.command),
  isDestructive: (args: { command: string }) => /\brm\s+-rf\s+[~/]/.test(args.command),
} as any;

function decide(toolName: string, args: Record<string, unknown>, line: string | null, mode: any = 'acceptSafe') {
  const { submit } = classifyTerminalInput(toolName, args, line);
  return decideTerminalSubmitPermission({ kind: 'allow' }, submit, args.pane, commandHandler, mode, DEFAULT_PERMISSION_RULES);
}

test('typing without a submit key never runs anything', () => {
  assert.deepEqual(classifyTerminalInput('type_text', { text: 'rm -rf ~' }, '').submit, { kind: 'none' });
  assert.deepEqual(classifyTerminalInput('press_keys', { keys: 'Down Down' }, '').submit, { kind: 'none' });
  assert.deepEqual(decide('type_text', { text: 'rm -rf ~' }, ''), { kind: 'allow' });
});

test('a newline inside type_text submits every line it completes', () => {
  assert.deepEqual(classifyTerminalInput('type_text', { text: 'ls\nrm -rf /tmp/x\r' }, 'echo ').submit,
    { kind: 'commands', lines: ['echo ls', 'rm -rf /tmp/x'] });
  assert.deepEqual(decide('type_text', { text: 'rm -rf ~\n' }, ''), { kind: 'ask' });
  assert.deepEqual(decide('type_text', { text: 'ls -la\n' }, ''), { kind: 'allow' });
});

test('Enter submits what is already on the line, including earlier typed text', () => {
  assert.deepEqual(decide('press_keys', { keys: 'Enter' }, 'sudo id'), { kind: 'ask' });
  assert.deepEqual(decide('press_keys', { keys: ['Enter'] }, 'git status'), { kind: 'allow' });
  assert.deepEqual(decide('press_keys', { keys: 'Backspace Enter' }, 'rm -rf /tmp/xy'), { kind: 'ask' });
  assert.deepEqual(decide('press_keys', { keys: 'Ctrl-U Enter' }, 'sudo id'), { kind: 'allow' });
});

test('deny rules apply to submitted lines even in full-auto mode', () => {
  const perm = decide('press_keys', { keys: 'Enter' }, 'git reset --hard', 'acceptAll');
  assert.equal(perm.kind, 'deny');
  assert.equal(decide('type_text', { text: 'git push origin main --force\n' }, '', 'acceptAll').kind, 'deny');
  assert.deepEqual(decide('type_text', { text: 'rm -rf ~\n' }, '', 'acceptAll'), { kind: 'ask' });
  assert.deepEqual(decide('type_text', { text: 'rm -rf build\n' }, '', 'acceptAll'), { kind: 'allow' });
});

test('history recall, completion or an unreadable line make the submit unknown and ask', () => {
  assert.equal(classifyTerminalInput('press_keys', { keys: 'Up Enter' }, '').submit.kind, 'unknown');
  assert.equal(classifyTerminalInput('press_keys', { keys: 'Tab Enter' }, 'ls ').submit.kind, 'unknown');
  assert.equal(classifyTerminalInput('press_keys', { keys: 'Alt-Enter' }, 'ls').submit.kind, 'unknown');
  assert.deepEqual(decide('press_keys', { keys: 'Enter' }, null), { kind: 'ask' });
  assert.deepEqual(decide('press_keys', { keys: 'Up Enter' }, '', 'acceptAll'), { kind: 'ask' });
  assert.deepEqual(decide('press_keys', { keys: 'Ctrl-O' }, 'ls'), { kind: 'allow' });
  assert.equal(classifyTerminalInput('press_keys', { keys: 'Ctrl-O' }, 'sudo id').submit.kind, 'commands');
});

test('bypass mode and stricter base decisions are left untouched', () => {
  const { submit } = classifyTerminalInput('press_keys', { keys: 'Enter' }, null);
  assert.deepEqual(decideTerminalSubmitPermission({ kind: 'allow' }, submit, undefined, commandHandler, 'bypass', []), { kind: 'allow' });
  assert.deepEqual(decideTerminalSubmitPermission({ kind: 'ask' }, submit, undefined, commandHandler, 'acceptAll', []), { kind: 'ask' });
});
