import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSshTabTitle } from '../src/ssh-tab-title.ts';

test('SSH defaults to saved connection name regardless of remote title changes', () => {
  const config = { name: '生产服务器', host: '10.0.0.2' };
  for (const title of ['root@localhost:~', 'vim /etc/hosts', '']) {
    assert.equal(resolveSshTabTitle(title, config, undefined), '生产服务器');
    assert.equal(resolveSshTabTitle(title, config, 'connection'), '生产服务器');
    assert.equal(resolveSshTabTitle(title, config, 'terminal'), title);
  }
});
test('empty connection names fall back to host', () => {
  for (const name of [undefined, '', '   ']) assert.equal(resolveSshTabTitle('remote', { name, host: '10.0.0.2' }, 'connection'), '10.0.0.2');
});
test('local and shared session titles keep their existing rules', () => {
  for (const mode of ['connection', 'terminal'] as const) assert.equal(resolveSshTabTitle('local or shared title', undefined, mode), 'local or shared title');
});
test('switching preferences and focused SSH session preserves dynamic title for reuse', () => {
  const dynamicTitle = 'root@localhost:~';
  const left = { name: 'left', host: 'a' }, right = { name: 'right', host: 'b' };
  assert.equal(resolveSshTabTitle(dynamicTitle, left, 'connection'), 'left');
  assert.equal(resolveSshTabTitle(dynamicTitle, right, 'connection'), 'right');
  assert.equal(resolveSshTabTitle(dynamicTitle, right, 'terminal'), dynamicTitle);
  assert.equal(resolveSshTabTitle(dynamicTitle, { ...right }, 'connection'), 'right');
});
