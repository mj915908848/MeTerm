import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * Drift guard for the shell hook (OSC 7768), which has four independent
 * installers that are hand-copied from each other:
 *
 *   1. `src-tauri/src/server/terminal/pty_unix.rs`  — local zsh/bash rc files
 *   2. `src-tauri/src/server/terminal/ssh.rs`       — injected into the SSH shell
 *   3. `src-tauri/src/server/terminal/pty_windows.rs` — Windows pwsh
 *   4. `src/ai-tools-shell.ts`                      — desktop fallback injection
 *
 * The harm this guards against is concrete: the SSH installer silently dropped
 * the 4th OSC 7768 field (`duration_ms`), which disabled the "long command
 * finished" push for every SSH session without failing anything — the OSC
 * filter parses that field as optional. The same shape of mistake had already
 * left the two PowerShell payloads structurally different and left the SSH hook
 * as the only emitter without the shared history-hygiene policy.
 *
 * This is a test, not a refactor, on purpose: merging the installers requires
 * unifying `pty_unix.rs`'s rc-file generation with the one-line `eval` forms,
 * and two of the four (pwsh, and the fish branch) cannot be executed anywhere
 * in this repo. Pinning the contract keeps today's duplication safe and makes
 * any future divergence a red test instead of a silent behaviour change. Run
 * `shell-hook-duration.test.mts` alongside it — that one really executes the
 * zsh/bash hooks through real shells.
 */

const SRC = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/**
 * Drop whole-line comments and block comments.
 *
 * The contract below is about *emitted* fragments, so prose must not satisfy
 * it. The doc comment on `SHELL_INTEGRATION_HOOK` names `HIST_IGNORE_SPACE`,
 * `add-zsh-hook preexec` and `10#$` while explaining them — matching the raw
 * file meant the guard stayed green after the hook lost the policy it
 * documents. (Found by mutating the hook: the first fix cut the Rust test
 * modules, which was necessary but not sufficient.)
 *
 * Only whole-line comments are removed: a trailing-comment rule would have to
 * parse string literals, and these files embed shell code whose `#` comments
 * are payload, not Rust/TS comments.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/**
 * The code that actually ships: no in-file test module, no comments.
 *
 * The test modules matter on their own: the Rust assertions quote the exact
 * hook fragments (`HOOK.contains("add-zsh-hook preexec __meterm_preexec")`), so
 * a whole-file substring match would survive the production hook losing one.
 */
function shipped(source: string): string {
  const tests = source.indexOf('#[cfg(test)]');
  return stripComments(tests === -1 ? source : source.slice(0, tests));
}

const PTY_UNIX = shipped(SRC('src-tauri/src/server/terminal/pty_unix.rs'));
const PTY_WINDOWS = shipped(SRC('src-tauri/src/server/terminal/pty_windows.rs'));
const SSH = shipped(SRC('src-tauri/src/server/terminal/ssh.rs'));
const AI_SHELL = shipped(SRC('src/ai-tools-shell.ts')); // no in-file test module
const TERMINAL_OSC = stripComments(SRC('src/terminal-osc.ts'));

// Payloads exactly as they appear in the source text, escaping included
// (`\\033` in a Rust/TS source file is the same characters in both).
const OSC7768_4FIELD = '\\\\033]7768;%d;%s;%s;%d\\\\007'; // printf form, exit;cwd;cmd;duration_ms
const OSC7768_3FIELD = '\\\\033]7768;%d;%s;%s\\\\007'; // printf form WITHOUT duration_ms
const OSC7768_FISH_TAIL = '\\\\033]7768;%d;%s;\\\\007'; // fish's first-prompt form (2 fields)
const OSC7768_PWSH_TS = ']7768;$e;$(Get-Location);$c';
const OSC7768_PWSH_RS = "']7768;' + $e + ';' + (Get-Location) + ';' + $c";

/** Count non-overlapping occurrences of a literal. */
function count(haystack: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return n;
    n += 1;
    from = at + needle.length;
  }
}

interface VerifiableEmitter {
  name: string;
  source: string;
  /** How many 4-field OSC 7768 emitters this file must contain. */
  fourField: number;
  /** Absolute path (for failure messages). */
  path: string;
}

/**
 * The zsh/bash installers. All three are executable on this machine, so they
 * carry the full contract: 4 fields, a preexec-style timer feeding the 4th, and
 * the shared history policy.
 */
const VERIFIABLE: VerifiableEmitter[] = [
  {
    name: 'pty_unix.rs (local zsh rc + local bash rc)',
    source: PTY_UNIX,
    path: 'src-tauri/src/server/terminal/pty_unix.rs',
    fourField: 2,
  },
  {
    name: 'ssh.rs (injected into the remote shell)',
    source: SSH,
    path: 'src-tauri/src/server/terminal/ssh.rs',
    fourField: 1,
  },
  {
    name: 'ai-tools-shell.ts buildShellHook (zsh + bash branches)',
    source: AI_SHELL,
    path: 'src/ai-tools-shell.ts',
    fourField: 2,
  },
];

/** Every zsh/bash emitter carries the optional 4th field — the CmdDone signal. */
for (const emitter of VERIFIABLE) {
  test(`${emitter.name}: emits the 4-field OSC 7768 payload`, () => {
    assert.equal(
      count(emitter.source, OSC7768_4FIELD),
      emitter.fourField,
      `${emitter.path} must emit exactly ${emitter.fourField} four-field payload(s) `
      + `(exit;cwd;last_cmd;duration_ms). A 3-field payload parses fine and silently `
      + `kills the "long command finished" push for that whole session.`,
    );
  });
}

/**
 * A 4th field can only be real if something timestamps the command BEFORE it
 * runs, which needs a different mechanism per shell.
 */
for (const emitter of VERIFIABLE) {
  test(`${emitter.name}: installs preexec timing for both shells`, () => {
    assert.ok(
      emitter.source.includes('add-zsh-hook preexec __meterm_preexec'),
      `${emitter.path}: zsh needs \`add-zsh-hook preexec\` or duration is always 0`,
    );
    assert.ok(
      emitter.source.includes("trap '__meterm_preexec' DEBUG"),
      `${emitter.path}: bash needs the DEBUG-trap preexec or duration is always 0`,
    );
    assert.ok(
      emitter.source.includes('10#$'),
      `${emitter.path}: bash must force base-10 on split EPOCHREALTIME halves `
      + `(a fraction like 012345 is otherwise read as octal)`,
    );
  });
}

/**
 * History hygiene is a shared policy, not a local choice: the agent (and the
 * user answering a `sudo` prompt) spaces-prefixes commands to keep them out of
 * the history file. ssh.rs was the one emitter missing it, so the remote
 * history — the one that actually matters — kept recording prompt answers.
 */
for (const emitter of VERIFIABLE) {
  test(`${emitter.name}: applies the shared history-hygiene policy`, () => {
    assert.ok(
      emitter.source.includes('HIST_IGNORE_SPACE'),
      `${emitter.path}: zsh branch must \`setopt HIST_IGNORE_SPACE\``,
    );
    assert.ok(
      emitter.source.includes('ignorespace'),
      `${emitter.path}: bash branch must append \`ignorespace\` to HISTCONTROL`,
    );
  });
}

/**
 * The emitters that are deliberately still 3-field. Both are unverifiable here
 * (no `pwsh` binary, no CI coverage, no `fish`), and a syntax error inside an
 * injected hook is masked — the OSC 7766 detect marker fires *before* the
 * `eval`, so `hookInjected` would flip true while the hook is dead. Pinning the
 * exact counts means promoting one of these to 4 fields, or adding a new
 * unverifiable emitter, has to be a conscious edit to this table.
 */
test('the only 3-field emitters left are the unverifiable shells', () => {
  assert.equal(count(AI_SHELL, OSC7768_3FIELD), 1, 'ai-tools-shell.ts fish branch (post-exec form)');
  assert.equal(count(AI_SHELL, OSC7768_FISH_TAIL), 1, 'ai-tools-shell.ts fish branch (first-prompt form)');
  assert.equal(count(AI_SHELL, OSC7768_PWSH_TS), 1, 'ai-tools-shell.ts powershell branch');
  assert.equal(count(PTY_WINDOWS, OSC7768_PWSH_RS), 1, 'pty_windows.rs pwsh hook');
  assert.equal(count(PTY_WINDOWS, OSC7768_4FIELD), 0, 'pty_windows.rs has no duration timer yet');

  // The zsh/bash-only installers must not carry a 3-field payload at all.
  // (ai-tools-shell.ts is excluded: it also holds the fish/powershell branches
  // pinned above, so a 3-field printf is expected *somewhere* in that file.)
  for (const source of [PTY_UNIX, SSH]) {
    for (const threeField of [OSC7768_3FIELD, OSC7768_FISH_TAIL]) {
      assert.equal(count(source, threeField), 0, 'no 3-field printf payload is allowed here');
    }
  }
});

/**
 * Nothing may emit OSC 7768 that the table above does not account for.
 *
 * Every leftover count is zero now that the Rust test modules are cut out:
 * any non-zero number means an emitter was added, removed, or changed shape.
 */
test('no OSC 7768 emitter escapes the table', () => {
  const expectedLeftovers: Record<string, number> = {
    'pty_unix.rs': 0,
    'ssh.rs': 0,
    'pty_windows.rs': 0,
    'ai-tools-shell.ts': 0,
  };

  const accounted = (source: string, shapes: string[]): number =>
    shapes.reduce((sum, shape) => sum + count(source, shape), 0);

  const files: Array<[string, string, string[]]> = [
    ['pty_unix.rs', PTY_UNIX, [OSC7768_4FIELD]],
    ['ssh.rs', SSH, [OSC7768_4FIELD]],
    ['pty_windows.rs', PTY_WINDOWS, [OSC7768_PWSH_RS]],
    ['ai-tools-shell.ts', AI_SHELL, [OSC7768_4FIELD, OSC7768_3FIELD, OSC7768_FISH_TAIL, OSC7768_PWSH_TS]],
  ];

  for (const [label, source, shapes] of files) {
    const total = count(source, ']7768;');
    const leftover = total - accounted(source, shapes);
    assert.equal(
      leftover,
      expectedLeftovers[label],
      `${label}: ${total} OSC 7768 reference(s), ${accounted(source, shapes)} accounted for by the `
      + `table — ${leftover} left over. A number has changed, so either an emitter was added/removed `
      + `or a payload shape changed. Update the contract table deliberately.`,
    );
  }
});

/**
 * The OSC 7766 init marker carries a shell-type index that the frontend maps
 * through a hard-coded array. If either side is reordered, `hookInjected` still
 * flips true while the reported shell type is wrong (which is what
 * click-to-move and the empty-state badge use), so pin the pairing.
 */
test('the 7766 shell-type index contract is intact', () => {
  const listMatch = TERMINAL_OSC.match(/const shellTypes = \[([^\]]+)\]/);
  assert.ok(listMatch, 'terminal-osc.ts must still declare the shell-type array');
  const shellTypes = listMatch[1].split(',').map((entry) => entry.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(shellTypes, ['bash', 'zsh', 'fish', 'powershell']);

  // Each installer must advertise the index that matches the server name it installs.
  assert.equal(shellTypes.indexOf('zsh'), 1);
  assert.ok(PTY_UNIX.includes("]7766;meterm_init;1"), 'pty_unix.rs zsh rc announces zsh (1)');
  assert.ok(PTY_UNIX.includes("]7766;meterm_init;0"), 'pty_unix.rs bash rc announces bash (0)');
  assert.ok(PTY_WINDOWS.includes(']7766;meterm_init;3'), 'pty_windows.rs announces powershell (3)');

  const sshCodes = [...SSH.matchAll(/meterm_init;(\d)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(sshCodes)].sort(),
    ['0', '1'],
    'ssh.rs injects into zsh/bash, so it announces zsh (1) and bash (0)',
  );
  for (const code of sshCodes) {
    assert.ok(['0', '1'].includes(code), `unexpected ssh hook shell-type index ${code}`);
  }
});
