import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRecordTypedLine } from '../src/terminal-history-filter.ts';

test('ordinary commands at a shell prompt are recorded', () => {
  assert.equal(shouldRecordTypedLine('ls -la', 'jie@mac ~ % ls -la', false), true);
  assert.equal(shouldRecordTypedLine('git status', 'root@web:/srv# git status', false), true);
  assert.equal(shouldRecordTypedLine('echo pin', 'user@spinach:~$ echo pin', false), true);
});

test('input at password and secret prompts is never recorded', () => {
  for (const prompt of ['[sudo] password for jie: ', "jie@host's password: ", 'Password:', 'Enter password: ',
    'Enter passphrase for key \'/Users/jie/.ssh/id_ed25519\': ', 'Token (will be hidden): ', '请输入密码：', 'Verification code: ']) {
    assert.equal(shouldRecordTypedLine('hunter2', prompt, false), false, prompt);
  }
  // An echoing secret prompt is still a secret prompt.
  assert.equal(shouldRecordTypedLine('123456', 'OTP: 123456', false), false);
});

test('full-screen programs, blank lines and leading-space commands are skipped', () => {
  assert.equal(shouldRecordTypedLine(':wq', '~', true), false);
  assert.equal(shouldRecordTypedLine('   ', '$ ', false), false);
  assert.equal(shouldRecordTypedLine(' export TOKEN=abc', '$  export TOKEN=abc', false), false);
});
