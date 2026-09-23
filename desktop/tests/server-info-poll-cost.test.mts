import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const panel = read('server-info-panel.ts');

/**
 * The remote collector. Path is relative to this file, not to src/, because the
 * Rust side is what decides how much work the remote host is asked to do.
 */
const rust = fs.readFileSync(
  new URL('../src-tauri/src/server/server_info.rs', import.meta.url),
  'utf8',
);

/** Slice one member out of a class: from its signature to its own closing brace. */
function member(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `signature not found: ${signature}`);
  const rest = source.slice(start);
  const end = rest.search(/\n  \};?\n/);
  assert.ok(end > 0, `closing brace not found for: ${signature}`);
  return rest.slice(0, end);
}

const rustConst = (name: string): string => {
  const m = new RegExp(`const ${name}: &str = r#"(.*?)"#;`, 's').exec(rust);
  assert.ok(m, `${name} not found in server_info.rs`);
  return m[1];
};

// ── What the panel costs the remote host ──
//
// Both halves of the panel ride the same 5s timer, but they are not the same
// kind of thing: CPU/memory/network are gauges, the process box is a top-30
// list. Every `processes` request is a full `ps` scan of /proc, so the list is
// polled on a much slower schedule.

test('the process list is polled far less often than the gauges', () => {
  const process = /const PROCESS_INTERVAL_MS = (\d+);/.exec(panel);
  const tick = /const SYSINFO_INTERVAL_MS = (\d+);/.exec(panel);
  assert.ok(process && tick, 'both poll intervals must be declared');
  assert.ok(
    Number(process[1]) >= 3 * Number(tick[1]),
    `the process list must be at least 3x slower than sysinfo (got ${process[1]} vs ${tick[1]})`,
  );

  const body = member(panel, '  private requestSysInfo(forceProcesses = false): void {');
  assert.ok(
    /const due = forceProcesses \|\| this\.processTick % PROCESS_EVERY_TICKS === 0;/.test(body),
    'the processes request must be gated on the slower schedule',
  );
  const sysinfo = body.indexOf("requestServerInfo('sysinfo')");
  const gate = body.indexOf('const due =');
  assert.ok(sysinfo > 0 && sysinfo < gate, 'sysinfo must stay on every tick');
});

// Cheap on purpose: the gate has to cover the real request, not a lookalike.
test('the slower schedule actually guards the processes request', () => {
  const body = member(panel, '  private requestSysInfo(forceProcesses = false): void {');
  const gate = body.indexOf('const due =');
  const request = body.indexOf("if (due) fileManager?.requestServerInfo('processes')");
  assert.ok(request > gate, 'the processes request must sit behind the gate');
});

// Switching sessions must not wait for the slow schedule: the box would show
// the previous session's processes for up to 30s.
test('switching sessions refreshes the process list immediately', () => {
  const body = member(panel, '  syncToActiveSession(): void {');
  assert.ok(
    /if \(changed\) this\.requestSysInfo\(true\);/.test(body),
    'a session change must force a fresh process list',
  );
});

// ── Nothing on screen means nothing to poll ──
//
// The panel kept sending two SSH commands per 5s while the window was
// minimised or another app was in front.

test('polling pauses while the window is hidden or unfocused', () => {
  const hidden = member(panel, '  private onHiddenChange = (): void => {');
  assert.ok(hidden.includes('document.hidden'), 'the hidden state must be consulted');
  assert.ok(hidden.includes('this.stopPolling()'), 'a hidden document must stop the timer');
  assert.ok(hidden.includes('this.resumePolling()'), 'becoming visible must resume');

  const blur = member(panel, '  private onWindowBlur = (): void => {');
  assert.ok(blur.includes('this.stopPolling()'), 'losing focus must stop the timer');

  const resume = member(panel, '  private resumePolling = (): void => {');
  assert.ok(resume.includes('this.startPolling()'), 'resuming must restart the timer');
  assert.ok(
    /if \(wasStopped\) this\.requestSysInfo\(true\);/.test(resume),
    'resuming must refresh at once instead of showing stale numbers for a tick',
  );
});

// Three signals, so one missed event cannot freeze the panel for good — and the
// resume path must not depend on a focus query that could answer wrong.
test('several independent signals resume polling', () => {
  for (const listener of [
    "document.addEventListener('visibilitychange', this.onHiddenChange)",
    "window.addEventListener('blur', this.onWindowBlur)",
    "window.addEventListener('focus', this.resumePolling)",
    "document.addEventListener('pointerdown', this.resumePolling, true)",
  ]) {
    assert.ok(panel.includes(listener), `missing listener: ${listener}`);
  }
  const resume = member(panel, '  private resumePolling = (): void => {');
  assert.ok(
    !resume.includes('hasFocus'),
    'the resume path must not re-query focus: a wrong answer would leave the panel frozen',
  );
});

// ── What the remote command costs ──

// Asking whether `ps` supports `-eo --sort` used to run `ps` twice — and with
// `--sort`, `ps` cannot stream: it reads every /proc entry before printing.
test('the process command scans /proc once on the common path', () => {
  const cmd = rustConst('PROCESS_LIST_CMD');
  assert.equal(
    cmd.split('ps -eo').length - 1,
    1,
    'the common path must run one ps, not a probe plus a run',
  );
  assert.ok(cmd.includes('ps aux'), 'the BusyBox fallback must stay for hosts without --sort');
  assert.ok(!cmd.includes('||'), 'a pipeline exit status hides the first command failing');
});

// Computing CPU% inside the script cost a `sleep 1`, holding the exec channel
// open for a second on every poll. It is derived from two samples now.
test('the remote sysinfo script never sleeps to sample CPU', () => {
  const script = rustConst('SYSINFO_SCRIPT');
  assert.ok(!script.includes('sleep'), 'no sleep in the sysinfo script');
  assert.ok(script.includes('CPU_TICKS='), 'raw /proc/stat counters instead of a percentage');
});

// The two sides have to agree on one shape, and this is the side that decides
// how much of /proc is touched per poll.
test('the process box still gets a full page of rows after filtering', () => {
  const cmd = rustConst('PROCESS_LIST_CMD');
  const head = /head -(\d+)/.exec(cmd);
  assert.ok(head, 'the command must cap its own output');
  assert.ok(
    Number(head[1]) >= 40,
    'the filters drop a few rows, so the command must over-fetch (head -40)',
  );
});

// The fallback is not an exotic path: it is what every host without GNU procps
// runs — BusyBox, and BSD/macOS, whose `ps` has no `--sort` at all. It shipped
// with neither a cap nor an ordering, so those hosts got the *entire* process
// table piped back (the parser's `.take(30)` runs after the transfer) and a "top
// 30" that was really "the first 30 rows of ps aux".
test('the portability fallback is capped and CPU-ordered too', () => {
  const cmd = rustConst('PROCESS_LIST_CMD');
  const fallback = cmd.split('else ')[1] ?? '';
  assert.ok(fallback, 'the portable branch must stay — most hosts are not GNU procps');
  assert.ok(fallback.includes('head -'), 'the fallback must cap its output as well');
  assert.ok(/sort\s+-k3\s+-rn/.test(fallback), 'the fallback must order by %CPU (field 3)');
  assert.equal(
    cmd.split('head -40').length - 1,
    2,
    'both branches need the cap, at the same size as the common path',
  );
  assert.ok(
    fallback.indexOf("awk 'NR>1'") < fallback.indexOf('sort'),
    'the header has to be dropped before sorting, or it is sorted into the list as a bogus row',
  );
});
