import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The local zsh hook points ZDOTDIR at a temp dir of proxy rc files. Those
 * proxies must load the user's own files from wherever zsh would have found
 * them — including a ZDOTDIR the user's ~/.zshenv sets (the usual XDG layout,
 * `~/.config/zsh`) or one they launched with. They used to hard-code $HOME, so
 * such users got a bare zsh with none of their prompt, aliases or plugins.
 */

/** The body of the Rust string literal that follows `marker`, unescaped. */
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
const RC_FILES = ['zshenv', 'zprofile', 'zshrc', 'zlogin'];

const hasZsh = !spawnSync('zsh', ['-c', 'exit 0']).error;

/** Start a login + interactive zsh through the proxies and report what it loaded. */
function startZsh(home: string, userZdotdir?: string): { loaded: string[]; zdotdir: string; hooked: boolean } {
  const proxy = mkdtempSync(join(tmpdir(), 'meterm-zd-proxy-'));
  for (const name of RC_FILES) {
    writeFileSync(join(proxy, `.${name}`), rustLiteral(PTY_UNIX, `dir.join(".${name}"),`));
  }
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home, ZDOTDIR: proxy };
  if (userZdotdir) env.METERM_USER_ZDOTDIR = userZdotdir;
  const run = spawnSync('zsh', ['-l', '-i', '-c', 'echo "ZD=$ZDOTDIR"; (( $+functions[__meterm_precmd] )) && echo HOOKED'], {
    encoding: 'utf8', env, timeout: 30_000,
  });
  const out = run.stdout ?? '';
  return {
    loaded: [...out.matchAll(/LOADED (\S+)/g)].map((m) => m[1]),
    zdotdir: /ZD=(.*)/.exec(out)?.[1] ?? '',
    hooked: out.includes('HOOKED'),
  };
}

function userDir(dir: string, tag: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of RC_FILES) writeFileSync(join(dir, `.${name}`), `echo LOADED ${tag}/${name}\n`);
}

test('a plain $HOME config still loads every rc file', { skip: !hasZsh }, () => {
  const home = mkdtempSync(join(tmpdir(), 'meterm-zd-home-'));
  userDir(home, 'home');
  const got = startZsh(home);
  assert.deepEqual(got.loaded, ['home/zshenv', 'home/zprofile', 'home/zshrc', 'home/zlogin']);
  assert.equal(got.zdotdir, home);
  assert.ok(got.hooked);
});

test('a ZDOTDIR set in ~/.zshenv is where the rest of the config comes from', { skip: !hasZsh }, () => {
  const home = mkdtempSync(join(tmpdir(), 'meterm-zd-home-'));
  const xdg = join(home, '.config', 'zsh');
  userDir(xdg, 'xdg');
  writeFileSync(join(home, '.zshenv'), 'export ZDOTDIR="$HOME/.config/zsh"\necho LOADED home/zshenv\n');
  const got = startZsh(home);
  // Same order zsh itself uses: ~/.zshenv, then the files under the new ZDOTDIR.
  assert.deepEqual(got.loaded, ['home/zshenv', 'xdg/zprofile', 'xdg/zshrc', 'xdg/zlogin']);
  assert.equal(got.zdotdir, xdg);
  assert.ok(got.hooked);
});

test('a ZDOTDIR the app was launched with is honoured', { skip: !hasZsh }, () => {
  const home = mkdtempSync(join(tmpdir(), 'meterm-zd-home-'));
  const launched = mkdtempSync(join(tmpdir(), 'meterm-zd-launched-'));
  userDir(home, 'home');
  userDir(launched, 'launched');
  const got = startZsh(home, launched);
  assert.deepEqual(got.loaded, ['launched/zshenv', 'launched/zprofile', 'launched/zshrc', 'launched/zlogin']);
  assert.equal(got.zdotdir, launched);
  assert.ok(got.hooked);
});

test('the user ZDOTDIR is passed in before the hook dir replaces it', () => {
  assert.match(PTY_UNIX, /cmd\.env\("METERM_USER_ZDOTDIR", zd\)/);
});
