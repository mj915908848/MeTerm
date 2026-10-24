import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * On macOS the local bash prompt is a second-stage, non-login shell started
 * with the proxy rc. Terminal.app and iTerm open a login shell, which reads
 * ~/.bash_profile and never ~/.bashrc, so that is where most macOS bash users
 * keep their aliases and prompt — and MeTerm used to read only ~/.bashrc.
 * With METERM_BASH_LOGIN (set by pty_unix.rs on macOS) the proxy reads the
 * login files instead, and still reads ~/.bashrc when the profile does not.
 */

function rustLiteral(source: string, marker: string): string {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `${marker} not found`);
  let i = source.indexOf('"', at + marker.length) + 1;
  let out = '';
  for (;;) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1];
      if (next === '\n') {
        i += 2;
        while (source[i] === ' ' || source[i] === '\t') i++;
        continue;
      }
      out += ({ n: '\n', t: '\t', '\\': '\\', '"': '"' } as Record<string, string>)[next];
      i += 2;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
    i++;
  }
}

const PTY_UNIX = readFileSync(new URL('../src-tauri/src/server/terminal/pty_unix.rs', import.meta.url), 'utf8');
const BASHRC = rustLiteral(PTY_UNIX, 'dir.join(".bashrc"),');
const hasBash = !spawnSync('bash', ['-c', 'exit 0']).error;

/** Start bash on the proxy rc and report which of the user's files it read. */
function loaded(files: Record<string, string>, login: boolean): string[] {
  const home = mkdtempSync(join(tmpdir(), 'meterm-bash-home-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(home, name), body);
  const rc = join(mkdtempSync(join(tmpdir(), 'meterm-bash-rc-')), '.bashrc');
  // /etc/bashrc is the host's own; keep it out so the result does not depend on it.
  writeFileSync(rc, BASHRC.replace('[[ -r /etc/bashrc ]] && source /etc/bashrc', ':'));
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home };
  if (login) env.METERM_BASH_LOGIN = '1';
  const run = spawnSync('bash', ['--rcfile', rc, '-i', '-c', 'echo "LOGIN=${METERM_BASH_LOGIN-unset}"'], {
    encoding: 'utf8', env, timeout: 30_000,
  });
  const out = run.stdout ?? '';
  assert.match(out, /LOGIN=unset/, 'the flag must not leak into the shell');
  return [...out.matchAll(/LOADED (\S+)/g)].map((m) => m[1]);
}

test('macOS: aliases kept in ~/.bash_profile are loaded', { skip: !hasBash }, () => {
  assert.deepEqual(
    loaded({ '.bash_profile': 'echo LOADED profile\n', '.bashrc': 'echo LOADED bashrc\n' }, true),
    ['profile', 'bashrc'],
    'a profile that does not source .bashrc still gets .bashrc after it',
  );
});

test('macOS: a profile that sources ~/.bashrc does not load it twice', { skip: !hasBash }, () => {
  assert.deepEqual(
    loaded({
      '.bash_profile': 'echo LOADED profile\n[ -f ~/.bashrc ] && . ~/.bashrc\n',
      '.bashrc': 'echo LOADED bashrc\n',
    }, true),
    ['profile', 'bashrc'],
  );
});

test('macOS: only the first of the login files is read, as bash itself does', { skip: !hasBash }, () => {
  assert.deepEqual(
    loaded({ '.bash_login': 'echo LOADED login\n', '.profile': 'echo LOADED dotprofile\n' }, true),
    ['login'],
  );
  assert.deepEqual(loaded({ '.bashrc': 'echo LOADED bashrc\n' }, true), ['bashrc']);
});

test('Linux: a non-login terminal shell reads ~/.bashrc only', { skip: !hasBash }, () => {
  assert.deepEqual(
    loaded({ '.bash_profile': 'echo LOADED profile\n', '.bashrc': 'echo LOADED bashrc\n' }, false),
    ['bashrc'],
  );
});

test('the flag is set only for the macOS second stage', () => {
  const macos = PTY_UNIX.slice(PTY_UNIX.indexOf('#[cfg(target_os = "macos")]'), PTY_UNIX.indexOf('#[cfg(not(target_os = "macos"))]'));
  assert.match(macos, /cmd\.env\("METERM_BASH_LOGIN", "1"\)/);
  assert.equal(PTY_UNIX.split('METERM_BASH_LOGIN", "1"').length, 2, 'set in exactly one place');
});
