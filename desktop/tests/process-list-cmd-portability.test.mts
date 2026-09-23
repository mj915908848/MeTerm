import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `PROCESS_LIST_CMD` executed against a stubbed `ps`, one flavour at a time.
 *
 * The guards that used to cover this command asserted only its *text* — that the
 * fallback contained `sort -k3 -rn` and two `head -40`s. That is how a fallback
 * which assumed BSD field positions in `ps aux` stayed green while every BusyBox
 * host (Alpine, containers) got either an empty list or a row whose `%CPU` was
 * some other column entirely: nothing ever checked what the pipeline *selects*
 * for a given host.
 *
 * So this file runs the real string, pulled out of the Rust source, through real
 * `bash` with a `ps` on PATH that behaves like the host under test. It is the
 * only place that can catch a field-position or branch-selection mistake, because
 * it is the only place that observes output rather than syntax.
 *
 * `ps` is a POSIX utility and the stubs are `#!/bin/sh` scripts, so this is
 * skipped on Windows rather than faked.
 */

const RUST_SOURCE = new URL('../src-tauri/src/server/server_info.rs', import.meta.url);

function extractCommand(): string {
  const source = readFileSync(RUST_SOURCE, 'utf8');
  const match = source.match(/const PROCESS_LIST_CMD: &str = r#"([\s\S]*?)"#;/);
  assert.ok(match, 'PROCESS_LIST_CMD not found in server_info.rs — did the declaration change?');
  return match![1];
}

const COMMAND = extractCommand();

/**
 * A stub `ps` driven by `$FAKE_PS`, standing in for the three flavours:
 *
 * - `gnu` — `ps -eo … --sort` works (the common path, one scan).
 * - `bsd` — `-eo --sort` fails; `ps aux` prints `USER PID %CPU %MEM … COMMAND`,
 *   with the command line as the *tail* of the row.
 * - `busybox` — `-eo --sort` fails; `ps aux` errors out the way BusyBox does;
 *   `ps -o pid,user,comm` works.
 * - `busybox_lax` — the harder variant the review raised: `ps aux` exits 0 but
 *   prints BusyBox's own `PID USER COMMAND`, so the branch can only be stopped by
 *   the shape of the rows, not by the exit status.
 */
const PS_STUB = `#!/bin/sh
mode="$FAKE_PS"
args="$*"
case "$mode" in
  gnu)
    case "$args" in
      *-eo*)
        printf '%s\\n' \\
          "    1 root  40.0  1.0 01:02:03 init" \\
          "  900 www    0.5  2.0 00:20 nginx: worker"
        exit 0 ;;
      *) exit 1 ;;
    esac ;;
  bsd)
    case "$args" in
      *-eo*) exit 1 ;;
      *aux*)
        printf '%s\\n' \\
          "USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND" \\
          "root         1  0.1  0.2  12345  1234 ?        Ss   10:00   0:01 /sbin/init" \\
          "www        900 42.5  1.5  23456  2345 ?        S    10:01   0:02 nginx: worker" \\
          "root        42  0.0  0.0   9999   999 ?        S    10:02   0:00 bash"
        exit 0 ;;
      *) exit 1 ;;
    esac ;;
  busybox)
    case "$args" in
      *-eo*) exit 1 ;;
      *aux*) printf "ps: invalid option -- 'a'\\n" >&2; exit 1 ;;
      *-o*)
        printf '%s\\n' \\
          "PID   USER     COMMAND" \\
          "    1 root     init" \\
          "   42 root     nginx" \\
          "  900 www      httpd"
        exit 0 ;;
      *) exit 1 ;;
    esac ;;
  busybox_lax)
    case "$args" in
      *-eo*) exit 1 ;;
      *aux*|*-o*)
        printf '%s\\n' \\
          "PID   USER     COMMAND" \\
          "    1 root     init" \\
          "   42 root     nginx"
        exit 0 ;;
      *) exit 1 ;;
    esac ;;
  busybox_many)
    case "$args" in
      *-eo*) exit 1 ;;
      *aux*) printf "ps: invalid option -- 'a'\\n" >&2; exit 1 ;;
      *-o*)
        printf '%s\\n' "PID   USER     COMMAND"
        i=1
        while [ "$i" -le 60 ]; do
          printf '%6d root     svc%d\\n' "$i" "$i"
          i=$((i + 1))
        done
        exit 0 ;;
      *) exit 1 ;;
    esac ;;
esac
exit 1
`;

const binDir = mkdtempSync(join(tmpdir(), 'meterm-procps-'));
writeFileSync(join(binDir, 'ps'), PS_STUB);
chmodSync(join(binDir, 'ps'), 0o755);

/** Run the shipped command with a `ps` that behaves like `mode`. */
function rowsFor(mode: string): string[] {
  const out = execFileSync('bash', ['-c', COMMAND], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FAKE_PS: mode },
  });
  return out.split('\n').filter(line => line.trim().length > 0);
}

/** `pid user cpu mem time command…` — the exchange format `parse_process_output` reads. */
function fields(row: string): string[] {
  return row.trim().split(/\s+/);
}

const skip = process.platform === 'win32' ? 'posix `ps` is not available on Windows' : false;

test('the GNU path is one scan and keeps real CPU, memory and elapsed time', { skip }, () => {
  const rows = rowsFor('gnu');
  assert.equal(rows.length, 2, 'both rows should come back');
  assert.deepEqual(fields(rows[0]), ['1', 'root', '40.0', '1.0', '01:02:03', 'init']);
  assert.equal(fields(rows[1])[2], '0.5', '%CPU is column 3 of the exchange format');
});

test('BSD `ps aux` rows are read by their BSD field positions', { skip }, () => {
  const rows = rowsFor('bsd');
  assert.equal(rows.length, 3, 'the header must not survive as a row');

  // Ordered by %CPU, descending: 42.5, 0.1, 0.0 — the header is stripped before
  // the sort, so it cannot land in the middle of the list.
  assert.deepEqual(rows.map(fields).map(f => f[0]), ['900', '1', '42']);
  assert.deepEqual(fields(rows[0]).slice(1), ['www', '42.5', '1.5', '-', 'nginx:', 'worker']);
});

test('a BSD row keeps the whole command line, not just its first word', { skip }, () => {
  const nginx = rowsFor('bsd').map(fields).find(f => f[0] === '900');
  assert.ok(nginx, 'the nginx row should be present');
  assert.equal(
    nginx!.slice(5).join(' '), 'nginx: worker',
    '`ps aux` puts the command line in the trailing fields; reading only one of them truncated it',
  );
});

test('BusyBox, whose `ps aux` errors out, still gets a process list', { skip }, () => {
  const rows = rowsFor('busybox');
  assert.equal(rows.length, 3, 'falling through the BSD branch must not mean an empty panel');
  assert.deepEqual(fields(rows[0]), ['1', 'root', '-', '-', '-', 'init']);
});

test('the degraded list marks the metrics it cannot know instead of scoring them zero', { skip }, () => {
  // BusyBox has no %CPU/%MEM column at all. A fabricated `0.0` would render as
  // "measured, and idle" on every row, which is worse than saying nothing.
  for (const row of rowsFor('busybox')) {
    const f = fields(row);
    assert.equal(f[2], '-', `%CPU must be the unknown marker, got ${f[2]} in "${row}"`);
    assert.equal(f[3], '-', `%MEM must be the unknown marker, got ${f[3]} in "${row}"`);
  }
});

test('BusyBox output is never read through BSD positions, even when `ps aux` exits 0', { skip }, () => {
  // The review's harder case: the command cannot lean on the exit status, so the
  // BSD branch has to reject `PID USER COMMAND` rows on their shape. Without that
  // guard these rows are read as `USER PID %CPU`, i.e. user "1", pid 42 parsed
  // from the *username*, and a %CPU taken from the command name.
  const rows = rowsFor('busybox_lax');
  assert.equal(rows.length, 2);
  assert.deepEqual(fields(rows[0]), ['1', 'root', '-', '-', '-', 'init']);
  assert.equal(fields(rows[0])[2], '-', 'no fabricated %CPU from a BusyBox row');
});

test('the degraded list is capped on the host, not after the transfer', { skip }, () => {
  // `.take(30)` in parse_process_output runs on this side of the SSH channel, so
  // a cap that lives there cannot stop the whole process table crossing the wire.
  const rows = rowsFor('busybox_many');
  assert.equal(rows.length, 40, '60 rows on the host must not all come back');
  assert.equal(fields(rows.at(-1)!)[0], '40', 'and the cap keeps the first 40, in order');
});
