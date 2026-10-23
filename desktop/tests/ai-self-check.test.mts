import assert from 'node:assert/strict';
import test from 'node:test';
import { commandLooksMutating, newSelfCheckState, noteToolCall, selfCheckNote, stepsLeftAfterReply } from '../src/ai-self-check.ts';

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

test('read-only command lines are not changes', () => {
  for (const cmd of [
    'cat /proc/loadavg; free -m; df -h',
    'sudo -n journalctl -u nginx --since "30 min ago" 2>&1 | tail -50',
    'systemctl status nginx; systemctl is-enabled nginx',
    'ss -tlnp 2>/dev/null | grep 80',
    'docker ps -a; docker logs --tail 50 web 2>&1',
    'find / -name "*.conf" 2>/dev/null | head',
    'apt list --upgradable',
    "awk '{ if ($1 > 5) print }' /proc/loadavg",
    'docker ps &>/dev/null && echo up',
    'journalctl -p err 2>/dev/stderr | tail',
  ]) assert.equal(commandLooksMutating(cmd), false, cmd);
});

test('changing command lines are changes', () => {
  for (const cmd of [
    'sudo systemctl restart nginx',
    'apt-get install -y htop',
    'rm -rf /tmp/x',
    'cd /etc && sudo -n mv a b',
    "sed -i 's/80/8080/' /etc/app.conf",
    'echo port=8080 > /etc/app.conf',
    'echo x | sudo tee -a /etc/hosts',
    'docker compose up -d',
    'kubectl apply -f deploy.yaml',
    'pacman -Syu',
    '  rm /tmp/x',
    'find /var/log -name "*.gz" -delete',
    'find /tmp -name x -exec rm {} +',
    'ls *.bak | xargs rm',
  ]) assert.equal(commandLooksMutating(cmd), true, cmd);
});

test('the reply covers a single remaining plan step', () => {
  assert.deepEqual(stepsLeftAfterReply([
    { content: 'Check load', status: 'completed' },
    { content: 'Write the report', status: 'in_progress' },
  ]), []);
  assert.deepEqual(stepsLeftAfterReply([
    { content: 'Restart nginx', status: 'pending' },
    { content: 'Check the site', status: 'pending' },
  ]), ['Restart nginx', 'Check the site']);
});

test('the note asks for a one-line answer when nothing needs fixing', () => {
  const s = newSelfCheckState();
  noteToolCall(s, 'edit_file', true, false);
  assert.match(selfCheckNote(s, [], 'Done.', true) ?? '', /ONE short line/);
});
