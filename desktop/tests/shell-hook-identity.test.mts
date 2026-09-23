import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * Drift guard for the nested-ssh host-identity comparison.
 *
 * The problem it solves: after the user types `ssh other-host`, the screen shows
 * a bare shell prompt that `injectionBlocked()` reads as *ours*, so the desktop's
 * shell-hook injection gets typed into the **nested** shell and the session is
 * then marked `hookInjected = true` with the other machine's cwd, exit codes and
 * durations — and `hookInjected` is exactly what switches the screen-tail
 * fallbacks off, so the AI features degrade silently. The screen cannot tell the
 * two shells apart; the SSH **exec channel** can, because it is a second channel
 * on the connection we dialled.
 *
 * So the identity is computed twice, in two languages, from the same expression:
 *
 *   - `src-tauri/src/server/server_info.rs` — `HOST_IDENTITY_CMD`, run on the
 *     exec channel and printed back.
 *   - `src/ai-tools-shell.ts` — `HOST_IDENTITY_EXPR`, evaluated inside the shell
 *     the injection lands in, and compared with that answer.
 *
 * This drift is the worst kind to catch late: if the two expressions stop
 * matching, nothing errors — every injection simply looks like a foreign host
 * and is refused, on every session, leaving the AI features degraded with an
 * empty log. Hence a test that reads both files and compares their text. (The
 * repo's other hook pins are text-based too; see `shell-hook-drift.test.mts`.)
 */

const SRC = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const AI_SHELL = SRC('src/ai-tools-shell.ts');
const SERVER_INFO = SRC('src-tauri/src/server/server_info.rs');
const COMMANDS_SSH = SRC('src-tauri/src/commands/ssh.rs');
const LIB_RS = SRC('src-tauri/src/lib.rs');
const TERMINAL_OSC = SRC('src/terminal-osc.ts');

/** The value of a TS `const NAME = 'a' + 'b';`, fragments concatenated. */
function tsConcatString(source: string, name: string): string {
  const start = source.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `${name} must still be declared in this file`);
  const end = source.indexOf(';', start);
  assert.notEqual(end, -1, `the ${name} initializer must still end with ';'`);
  const fragments = [...source.slice(start, end).matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.ok(
    fragments.length > 0,
    `${name} must still be a string literal (line-wrapped concatenation is fine, `
    + `but this extractor only understands single-quoted fragments)`,
  );
  return fragments.join('');
}

/** The value of a Rust `const NAME: &str = "..."`, escape sequences applied. */
function rustStringConst(source: string, name: string): string {
  const match = new RegExp(`const ${name}: &str = "((?:[^"\\\\]|\\\\.)*)"`).exec(source);
  assert.ok(match, `${name} must still be declared as a plain &str literal`);
  // JSON and Rust agree on the escapes this constant may use (\" and \\);
  // Rust's line-continuation escape is deliberately not supported, so a
  // re-wrapped constant fails here instead of silently extracting a prefix.
  return JSON.parse(`"${match[1]}"`) as string;
}

const TS_EXPR = tsConcatString(AI_SHELL, 'HOST_IDENTITY_EXPR');
const RS_CMD = rustStringConst(SERVER_INFO, 'HOST_IDENTITY_CMD');

/** The three sources, in the order the identity string joins them. */
const IDENTITY_FIELDS = [
  '$(cat /etc/machine-id 2>/dev/null||cat /var/lib/dbus/machine-id 2>/dev/null)',
  '$(hostname 2>/dev/null)',
  '$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)',
];

test('the exec channel and the injection compute the same identity', () => {
  assert.ok(
    RS_CMD.startsWith(TS_EXPR),
    'server_info.rs must compute the identity with the identical expression ai-tools-shell.ts uses. '
    + 'If these drift apart, every injection looks like a foreign host and is refused — on every '
    + 'session, with nothing in the logs to say why.\n'
    + `  TS  HOST_IDENTITY_EXPR: ${TS_EXPR}\n`
    + `  RS  HOST_IDENTITY_CMD:  ${RS_CMD}`,
  );
  assert.ok(
    RS_CMD.length > TS_EXPR.length,
    'the exec form has to *print* the identity, not merely compute it — otherwise the probe '
    + 'returns an empty capture and the guard degrades to nothing',
  );
});

test('the identity is machine-id | hostname | boot_id, in that order', () => {
  assert.equal(
    TS_EXPR,
    `__meterm_id="${IDENTITY_FIELDS.join('|')}"`,
    'the three fields are the whole contract: stable within a boot, different between machines, '
    + 'joined into one string so that any single field differing is enough to refuse. Reordering '
    + 'them silently disables the guard; dropping one weakens it. Every part is optional and '
    + 'stderr is dropped, so a host with none of them yields a degenerate `||` that still compares.',
  );
});

test('the injection actually compares before it types anything', () => {
  assert.ok(
    AI_SHELL.includes('${HOST_IDENTITY_EXPR}; if [ "$__meterm_id" = '),
    'the expression has to be interpolated into the very command that gets typed — declaring it '
    + 'and never using it would leave the whole guard inert while this test stayed green',
  );
  assert.ok(
    AI_SHELL.includes('HOOK_FOREIGN_HOST_CODE'),
    'the mismatch branch must report a distinct code, not just fall out of the `if` silently',
  );
  assert.ok(
    /ssh_exec\(ssh_handle, HOST_IDENTITY_CMD/.test(SERVER_INFO),
    'the probe must actually run HOST_IDENTITY_CMD on the exec channel',
  );
});

/**
 * The mismatch code goes back as OSC 7766, which `terminal-osc.ts` routes by
 * index. The guard is only worth anything if a mismatch can never be read as a
 * *successful* handshake — which for an in-range code it would be, since the
 * resolver coerces the payload straight through `shellTypes[]`.
 */
test('the foreign-host code can never be read as a shell-type index', () => {
  const declared = /const HOOK_FOREIGN_HOST_CODE = (\d+)/.exec(AI_SHELL);
  assert.ok(declared, 'HOOK_FOREIGN_HOST_CODE must still be declared');
  const code = Number(declared[1]);

  const listMatch = TERMINAL_OSC.match(/const shellTypes = \[([^\]]+)\]/);
  assert.ok(listMatch, 'terminal-osc.ts must still declare the shell-type array');
  const shellTypes = listMatch[1].split(',').map((entry) => entry.trim().replace(/^'|'$/g, ''));

  assert.ok(
    code >= shellTypes.length,
    `code ${code} must sit outside 0..${shellTypes.length - 1}. terminal-osc.ts forwards the `
    + `payload as shellTypes[code], so an in-range code would be reported as a *detected* shell `
    + `type while the hook was in fact refused.`,
  );

  const handledAt = AI_SHELL.indexOf('code === HOOK_FOREIGN_HOST_CODE');
  const successAt = AI_SHELL.indexOf('mt.shellState.hookInjected = true');
  assert.notEqual(handledAt, -1, 'the 7766 callback must recognise the mismatch code');
  assert.notEqual(successAt, -1, 'the 7766 callback must still have a success path');
  assert.ok(
    handledAt < successAt,
    'the mismatch must return before `hookInjected = true`: that flag is what turns the '
    + 'screen-tail fallbacks off, so setting it on a refusal would break the session quietly',
  );
});

/**
 * `None` is a first-class answer from the probe, not an error path: a local or
 * JumpServer session has no exec channel at all, and any probe failure degrades
 * the same way. Losing the guard may not lose the feature.
 */
test('a missing answer degrades to the previous unguarded injection', () => {
  assert.ok(
    AI_SHELL.includes("{ status: 'none' }"),
    'ai-tools-shell.ts must keep the "nothing to ask" state',
  );
  assert.ok(
    AI_SHELL.includes("host.status === 'known' ? host.value : undefined"),
    'only a *known* host may pass a guard value; everything else must inject unguarded',
  );
  assert.ok(
    AI_SHELL.includes("invoke<string | null>('ssh_host_identity'"),
    'the frontend must actually ask — and must treat `null` as an answer, not a failure',
  );
  assert.ok(
    COMMANDS_SSH.includes('pub async fn ssh_host_identity'),
    'commands/ssh.rs must expose the probe to the frontend',
  );
  assert.ok(
    COMMANDS_SSH.includes('probe_host_identity'),
    'the command must delegate to server_info::probe_host_identity rather than reimplementing it',
  );
  assert.ok(
    LIB_RS.includes('commands::ssh::ssh_host_identity'),
    'an unregistered command fails at runtime with a confusing message and no compile error',
  );
});
