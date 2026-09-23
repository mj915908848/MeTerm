import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Locate a top-level function declaration by name and return its source text.
 *
 * `ai-tools-shell.ts` / `ai-tools-core.ts` cannot be imported here: they pull in
 * the extensionless frontend graph, which Node's ESM resolver refuses to load.
 * Slicing by declaration name (not by nearby comment text) keeps this working
 * when comments or statement order change.
 */
function extractFn(file: string, name: string): string {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const fn = parsed.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(fn, `function ${name} not found in ${file}`);
  return fn.getText(parsed).replace('export ', '');
}

function loadFn<T>(file: string, name: string): T {
  const js = ts.transpileModule(extractFn(file, name), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(`${js}\nreturn ${name};`)() as T;
}

const buildShellHook = loadFn<(shellType: string) => string>('ai-tools-shell.ts', 'buildShellHook');
const escapeShellSingle = loadFn<(s: string) => string>('ai-tools-core.ts', 'escapeShellSingle');

// ── shell plumbing ────────────────────────────────────────────────

/** Every shell MeTerm's hook claims to support, as far as this machine has it. */
const CANDIDATES: Record<string, string[]> = {
  sh: ['sh', '/bin/sh'],
  bash: ['bash', '/bin/bash'],
  zsh: ['zsh', '/bin/zsh'],
};

function availableShell(candidates: string[]): string | null {
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['-c', 'exit 0'], { stdio: 'pipe' });
      return bin;
    } catch { /* not installed */ }
  }
  return null;
}

/** Parse-only check. Returns the shell's complaint, or null when it parses. */
function syntaxErrorIn(shell: string, script: string): string | null {
  const file = join(mkdtempSync(join(tmpdir(), 'meterm-hook-')), 'hook.sh');
  writeFileSync(file, script);
  try {
    execFileSync(shell, ['-n', file], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return String((err as { stderr?: unknown }).stderr ?? err).replace(/\s+/g, ' ').trim();
  }
}

/** Run the hook for real, once, and return the last OSC 7768 payload. */
function lastShellStatePayload(shell: string, hook: string, sleepSeconds: number): string {
  // The first precmd only announces the init marker (no command has run yet),
  // so burn it, then time one real command.
  const drive = [
    hook,
    '__meterm_precmd >/dev/null',
    `__meterm_preexec; sleep ${sleepSeconds}; __meterm_precmd`,
  ].join('\n');
  const out = execFileSync(shell, ['-c', drive], { encoding: 'utf8' });
  const payloads = out
    .split('\x1b')
    .filter((chunk) => chunk.includes(']7768;'))
    .map((chunk) => chunk.split('\x07')[0]);
  return payloads[payloads.length - 1] ?? '';
}

// ── payload shape ─────────────────────────────────────────────────

/**
 * The OSC filter treats `duration_ms` as optional (it keeps 3-field emitters
 * working), which is exactly how this hook shipped without it for months —
 * silently disabling the "long command finished" push for every SSH session
 * (`server/session/mod.rs::notify_events_to_publish` needs the 4th field).
 * Nothing failed loudly, so lock the arity down here.
 */
test('zsh and bash hooks carry duration_ms as the 4th OSC 7768 field', () => {
  for (const shellType of ['zsh', 'bash']) {
    const hook = buildShellHook(shellType);
    assert.match(
      hook,
      /7768;%d;%s;%s;%d\\007/,
      `${shellType} hook must emit exit;cwd;cmd;duration_ms`,
    );
    assert.equal(
      hook.match(/\]7768;/g)?.length,
      1,
      `${shellType} hook should have exactly one 7768 emitter`,
    );
  }
});

/** A duration is only measurable if something timestamps the command first. */
test('zsh and bash hooks install a preexec-style timer', () => {
  const zsh = buildShellHook('zsh');
  assert.match(zsh, /add-zsh-hook preexec __meterm_preexec/);
  assert.match(zsh, /zmodload zsh\/datetime/, 'zsh needs zsh/datetime for EPOCHREALTIME');

  const bash = buildShellHook('bash');
  assert.match(bash, /trap '__meterm_preexec' DEBUG/, 'bash has no preexec hook; use DEBUG');
  assert.match(
    bash,
    /10#\$\{?__e_sec/,
    "bash's $(( )) is integer-only, so the fraction must be 10#-forced out of octal",
  );
});

/**
 * These are shells, not strings: a syntax error means no hook at all — and the
 * failure is *masked*, because the 7766 detect marker is emitted before the
 * `eval`, so `hookInjected` still flips true while the hook is dead. Parse the
 * generated script (and its `eval`-quoted form, which is how it is injected).
 */
test('generated hooks parse in every supported shell', () => {
  for (const shellType of ['zsh', 'bash']) {
    const scripts = {
      plain: buildShellHook(shellType),
      'eval-quoted': `eval '${escapeShellSingle(buildShellHook(shellType))}'`,
    };
    for (const [label, script] of Object.entries(scripts)) {
      for (const [name, candidates] of Object.entries(CANDIDATES)) {
        const shell = availableShell(candidates);
        if (!shell) continue;
        const complaint = syntaxErrorIn(shell, script);
        assert.equal(complaint, null, `${shellType} hook (${label}) rejected by ${name}: ${complaint}`);
      }
    }
  }
});

/**
 * End-to-end: the emitted payload must actually carry a plausible duration.
 * `join('')` in buildShellHook glues the fragments together, so a missing
 * separator (`];then` + `dur=…` → `thendur=…`) produces a hook that parses as
 * garbage elsewhere — this catches it by running the thing.
 */
test('hooks report the real command duration', () => {
  const sleepSeconds = 1.2;
  for (const shellType of ['zsh', 'bash']) {
    const shell = availableShell(CANDIDATES[shellType]);
    if (!shell) continue;

    const payload = lastShellStatePayload(shell, buildShellHook(shellType), sleepSeconds);
    const match = /\]7768;(-?\d+);([^;]*);([^;]*);(\d+)$/.exec(payload);
    assert.ok(match, `${shellType}: expected a 4-field payload, got ${JSON.stringify(payload)}`);

    const durationMs = Number(match![4]);
    // bash before 5.0 has no EPOCHREALTIME and falls back to whole `$SECONDS`,
    // so only the lower bound is meaningful there.
    assert.ok(
      durationMs >= 1000,
      `${shellType}: duration ${durationMs}ms is too small for a ${sleepSeconds}s sleep`,
    );
    assert.ok(
      durationMs < 10_000,
      `${shellType}: duration ${durationMs}ms is implausible`,
    );
  }
});

/** The exit status must survive the extra preexec machinery. */
test('hooks still report the real exit code', () => {
  const shell = availableShell(CANDIDATES.bash);
  if (!shell) return;

  const hook = buildShellHook('bash');
  const drive = [
    hook,
    '__meterm_precmd >/dev/null',
    '__meterm_preexec; (exit 7); __meterm_precmd',
  ].join('\n');
  const out = execFileSync(shell, ['-c', drive], { encoding: 'utf8' });
  const payloads = out.split('\x1b').filter((c) => c.includes(']7768;')).map((c) => c.split('\x07')[0]);
  const payload = payloads[payloads.length - 1] ?? '';
  assert.match(payload, /\]7768;7;/, `expected exit 7 in ${JSON.stringify(payload)}`);
});
