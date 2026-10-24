import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * What the shell hook reports as "the command that just finished", and its exit
 * code, run through the real shells for every installer.
 *
 * Each of these shipped wrong while the payload-shape tests stayed green:
 *   - bash read the command with `fc -ln -1`, which inside PROMPT_COMMAND skips
 *     the newest entry and reports the one before — every command, one late;
 *   - every hook repeated the previous command after an empty Enter, and zsh
 *     reported space-prefixed lines the user meant to keep out of history;
 *   - bash ran first in PROMPT_COMMAND and left `$?` = 0 for the user's entries;
 *   - the SSH hook held a `[!…]` pattern that interactive zsh history-expands,
 *     so the whole line died with "event not found".
 */

// ── the three bash/zsh installers, as the shell receives them ─────

/** The body of a Rust string literal that follows `marker`, unescaped. */
function rustLiteral(rel: string, marker: string): string {
  const source = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `${marker} not found in ${rel}`);
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

function loadBuildShellHook(): (shellType: string, token?: string) => string {
  const file = 'ai-tools-shell.ts';
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const fn = parsed.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'buildShellHook',
  );
  assert.ok(fn, 'buildShellHook not found');
  const js = ts.transpileModule(fn.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(`${js}\nreturn buildShellHook;`)() as (shellType: string, token?: string) => string;
}

const buildShellHook = loadBuildShellHook();
const SSH_HOOK = rustLiteral('src-tauri/src/server/terminal/ssh.rs', 'pub(crate) const SHELL_INTEGRATION_HOOK: &str =');
const LOCAL_BASHRC = rustLiteral('src-tauri/src/server/terminal/pty_unix.rs', 'dir.join(".bashrc"),');
const LOCAL_ZSHRC = rustLiteral('src-tauri/src/server/terminal/pty_unix.rs', 'dir.join(".zshrc"),');

/** Each installer's hook text, stripped of the line that sources the user's rc. */
const INSTALLERS: Record<'bash' | 'zsh', Array<[string, string]>> = {
  bash: [
    ['local rc (pty_unix.rs)', LOCAL_BASHRC.replace(/^.*source "\$HOME\/\.bashrc".*$/m, '')],
    ['ssh hook (ssh.rs)', SSH_HOOK.replace(/stty echo\s*$/, '')],
    ['injected hook (ai-tools-shell.ts)', buildShellHook('bash')],
  ],
  zsh: [
    ['local rc (pty_unix.rs)', LOCAL_ZSHRC.replace(/^.*source "\$HOME\/\.zshrc".*$/m, '')],
    ['ssh hook (ssh.rs)', SSH_HOOK.replace(/stty echo\s*$/, '')],
    ['injected hook (ai-tools-shell.ts)', buildShellHook('zsh')],
  ],
};

function available(bin: string): boolean {
  const probe = spawnSync(bin, ['-c', 'exit 0'], { stdio: 'pipe' });
  return !probe.error && probe.status === 0;
}

/** Run a script and return each OSC 7768 payload as `exit;cmd`. */
function payloads(shell: string, script: string): string[] {
  const file = join(mkdtempSync(join(tmpdir(), 'meterm-hook-report-')), 'drive');
  writeFileSync(file, script);
  const out = execFileSync(shell, [file], { encoding: 'utf8', env: { ...process.env, METERM_OSC_TOKEN: 'T' } });
  return [...out.matchAll(/\x1b\]7768;k=[^;]*;(-?\d+);[^;]*;(.*?)(?:;\d+)?\x07/g)].map((m) => `${m[1]};${m[2]}`);
}

// ── bash ──────────────────────────────────────────────────────────

/**
 * One interactive prompt cycle, the way bash runs it: the line goes into history
 * (`history -s`, skipped for a space-prefixed line under ignorespace), the DEBUG
 * trap fires, the command runs, then PROMPT_COMMAND.
 */
function bashCycle(line: string, run: string): string {
  const record = line === '' || line.startsWith(' ') ? '' : `history -s ${JSON.stringify(line)}; `;
  return `${record}__meterm_preexec; ${run}; eval "$PROMPT_COMMAND"`;
}

test('bash: every installer reports the command that just ran, and nothing for an empty Enter', () => {
  if (!available('bash')) return;
  for (const [name, hook] of INSTALLERS.bash) {
    const script = [
      `PROMPT_COMMAND='echo "[user sees $?]"'`,
      hook,
      'history -s "echo earlier"',
      'eval "$PROMPT_COMMAND"', // first prompt: init only
      bashCycle('false', 'false'),
      bashCycle('echo hi', 'echo hi >/dev/null'),
      bashCycle('', 'true'), // empty Enter: nothing new in history
      bashCycle(' echo secret', 'echo secret >/dev/null'),
      bashCycle('ls /nope', '(exit 2)'),
      'true',
    ].join('\n');
    const file = join(mkdtempSync(join(tmpdir(), 'meterm-hook-report-')), 'drive');
    writeFileSync(file, script);
    const out = execFileSync('bash', [file], { encoding: 'utf8' });
    const reported = [...out.matchAll(/\x1b\]7768;k=[^;]*;(-?\d+);[^;]*;(.*?);\d+\x07/g)].map((m) => `${m[1]};${m[2]}`);
    assert.deepEqual(
      reported,
      ['0;', '1;false', '0;echo hi', '0;', '0;', '2;ls /nope'],
      `${name}: wrong command/exit sequence`,
    );
    // The user's own PROMPT_COMMAND runs after ours and must still see the real status.
    const seen = [...out.matchAll(/\[user sees (\d+)\]/g)].map((m) => m[1]);
    assert.deepEqual(seen.slice(1), ['1', '0', '0', '0', '2'], `${name}: user PROMPT_COMMAND lost $?`);
  }
});

// ── zsh ───────────────────────────────────────────────────────────

test('zsh: every installer reports the typed line, nothing for empty Enter or a space-prefixed line', () => {
  if (!available('zsh')) return;
  for (const [name, hook] of INSTALLERS.zsh) {
    const script = [
      hook,
      '__meterm_precmd', // first prompt: init only
      "__meterm_preexec 'false'; false; __meterm_precmd",
      "__meterm_preexec 'echo hi'; true; __meterm_precmd",
      'true; __meterm_precmd', // empty Enter: preexec never runs
      "__meterm_preexec ' echo secret'; true; __meterm_precmd",
      "__meterm_preexec 'ls /nope'; (exit 2); __meterm_precmd",
      'true', // the shared ssh.rs precmd hands the status on
    ].join('\n');
    assert.deepEqual(
      payloads('zsh', script),
      ['0;', '1;false', '0;echo hi', '0;', '0;', '2;ls /nope'],
      `${name}: wrong command/exit sequence`,
    );
  }
});

/**
 * The SSH hook is typed into an interactive shell, where zsh (BANG_HIST, on by
 * default) and bash history-expand `!` before running anything. A `[!0-9]`
 * pattern turned the whole line into "event not found: 0".
 */
test('the SSH hook line holds nothing interactive history expansion would rewrite', () => {
  for (const match of SSH_HOOK.matchAll(/!(.)/g)) {
    assert.ok(
      match[1] === '=' || match[1] === ' ',
      `ssh.rs hook contains "!${match[1]}", which an interactive zsh/bash expands from history`,
    );
  }
});

test('the bash installers remove their own line from the remote history', () => {
  assert.match(SSH_HOOK, /history -d \$HISTCMD/);
});

// ── PowerShell (no binary in CI: pin the order of the statements) ─

test('pwsh: the prompt hook reads $? before running anything else', () => {
  const source = readFileSync(new URL('../src-tauri/src/server/terminal/pty_windows.rs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function global:prompt {'));
  assert.match(body, /^function global:prompt \{ \\\s*\$__ok=\$\?;/, 'every statement resets $?, so it must be captured first');
  assert.ok(body.includes("Write-Error '' -ErrorAction Ignore"), 'the user prompt must see the failure too');
});
