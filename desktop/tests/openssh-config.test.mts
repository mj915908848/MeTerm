import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_OPENSSH_CONFIG_BYTES, parseOpenSshConfig } from '../src/openssh-config.ts';

test('imports literal aliases, inheriting matching settings in file order', () => {
  const config = [
    'User ops',
    'Host prod prod-alt',
    '  HostName = 2001:db8::1',
    '  Port=2222',
    '  IdentityFile "~/.ssh/work key" # comment',
    'Host * !LOCAL',
    '  Port 2200',
    'Host LOCAL',
    'Host DEV',
    'Host dev',
    '  User ignored-by-first-value',
  ].join('\r\n');

  assert.deepEqual(parseOpenSshConfig(config), {
    connections: [
      { name: 'prod', host: '2001:db8::1', port: 2222, username: 'ops', authMethod: 'key', privateKey: '~/.ssh/work key' },
      { name: 'prod-alt', host: '2001:db8::1', port: 2222, username: 'ops', authMethod: 'key', privateKey: '~/.ssh/work key' },
      { name: 'LOCAL', host: 'LOCAL', port: 22, username: 'ops', authMethod: 'key', usesDesktopKeyLadder: true },
      { name: 'DEV', host: 'DEV', port: 2200, username: 'ops', authMethod: 'key', usesDesktopKeyLadder: true },
    ],
    skipped: 0,
  });
});

test('skips aliases that would need different routing, host checks or credentials', () => {
  const result = parseOpenSshConfig(`
    User ops
    Host jump
      ProxyJump gateway
    Host no-host-check
      StrictHostKeyChecking no
    Host several-keys
      IdentityFile ~/.ssh/work
      IdentityFile ~/.ssh/personal
    Host path-expansion
      IdentityFile ~/.ssh/%h
    Host invalid-port
      Port 65536
    Host forced-default
      IdentitiesOnly yes
    Host constructor __proto__
    Host usable
      ProxyJump none
    Host *.example !keep.example
      ProxyCommand ssh gateway -W %h:%p
    Host ignore.example keep.example
  `);
  assert.deepEqual(result.connections.map(connection => connection.name), ['usable', 'keep.example']);
  assert.equal(result.skipped, 9);
});

test('requires a user, accepts a single Windows path and rejects it on macOS', () => {
  const config = String.raw`Host windows
    User admin
    IdentityFile "C:\Users\Example User\.ssh\id_ed25519"
    Host without-user`;
  assert.equal(parseOpenSshConfig(config, true).connections[0]?.privateKey, String.raw`C:\Users\Example User\.ssh\id_ed25519`);
  assert.deepEqual(parseOpenSshConfig(config).connections, []);
  assert.equal(parseOpenSshConfig(config, true).skipped, 1);
});

test('matches host patterns case-sensitively and keeps hashes inside unquoted paths', () => {
  const { connections } = parseOpenSshConfig(`
    Host PROD-* !PROD-1
      User fallback
    Host prod-1 PROD-1
      User deploy
      IdentityFile ~/.ssh/build#key # comment
  `);
  assert.deepEqual(connections.map(connection => [connection.name, connection.username, connection.privateKey]), [
    ['prod-1', 'deploy', '~/.ssh/build#key'],
  ]);
});

test('rejects oversized, malformed and dynamically resolved files', () => {
  assert.throws(() => parseOpenSshConfig('#'.repeat(MAX_OPENSSH_CONFIG_BYTES + 1)));
  assert.throws(() => parseOpenSshConfig('Host test\n  HostName "missing quote'));
  assert.throws(() => parseOpenSshConfig('Host test\nInclude extra.conf'), /Include and Match/);
  assert.throws(() => parseOpenSshConfig('Match exec "false"'), /Include and Match/);
});
