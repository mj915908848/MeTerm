import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quoteRemotePath } from '../src/ai-remote-path.ts';

/** What the remote shell actually sees as the argument, with HOME=/h. */
function expand(path: string): string {
  return execFileSync('sh', ['-c', `printf '%s' ${quoteRemotePath(path)}`], {
    encoding: 'utf8',
    env: { ...process.env, HOME: '/h' },
  });
}

test('~ and ~/ expand to $HOME, everything else stays literal', () => {
  assert.equal(expand('~'), '/h');
  assert.equal(expand('~/notes/a b.txt'), '/h/notes/a b.txt');
  assert.equal(expand("~/it's $USER `id`.txt"), "/h/it's $USER `id`.txt");
  assert.equal(expand('/etc/*.conf'), '/etc/*.conf');
  assert.equal(expand('~user/x'), '~user/x');
  assert.equal(expand('a/~/b'), 'a/~/b');
});

test('a leading dash cannot be read as an option', () => {
  assert.equal(expand('-n'), './-n');
  assert.equal(expand('--help'), './--help');
});

test('the write_file command shape works end to end with a ~ path', () => {
  const home = mkdtempSync(join(tmpdir(), 'meterm-remote-'));
  const p = quoteRemotePath('~/deep/dir/out.txt');
  execFileSync('sh', ['-c', `mkdir -p "$(dirname ${p})" && printf '%s' 'hi' > ${p} && head -n 5 ${p}`], {
    env: { ...process.env, HOME: home },
  });
  assert.equal(readFileSync(join(home, 'deep/dir/out.txt'), 'utf8'), 'hi');
});
