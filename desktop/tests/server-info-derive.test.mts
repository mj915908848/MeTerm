import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import {
  cpuUsageFromTicks,
  formatLoadAverage,
  nicKind,
  orderNicNames,
  pickDefaultNic,
  swapPercent,
} from '../src/server-info-derive.ts';

const read = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

const rustSource = fs.readFileSync(
  new URL('../src-tauri/src/server/server_info.rs', import.meta.url),
  'utf8',
);

// ── The uplink has to be chosen, not taken ──
//
// The chart used to auto-select `interfaces[0]`, i.e. whatever `/proc/net/dev`
// listed first. On a container host that is regularly docker0, so the panel
// opened on a bridge nobody cares about. Physical adapters now sort first.
test('the network dropdown lists the real uplink above virtual devices', () => {
  assert.deepEqual(
    orderNicNames(['docker0', 'veth1a2b', 'ens192', 'lo']),
    ['ens192', 'docker0', 'veth1a2b', 'lo'],
  );
  assert.deepEqual(
    orderNicNames(['br-9f2c', 'eth0', 'wlan0']),
    ['eth0', 'wlan0', 'br-9f2c'],
  );
});

// Names we cannot classify must not be pushed to the bottom with the virtual
// ones: br0 is often the machine's own bridge and belongs above docker's br-*.
test('unclassifiable names sit between the uplink and the virtual devices', () => {
  assert.deepEqual(orderNicNames(['virbr0', 'br0', 'ens3']), ['ens3', 'br0', 'virbr0']);
  assert.equal(nicKind('ens192'), 'physical');
  assert.equal(nicKind('eth0'), 'physical');
  assert.equal(nicKind('wlp3s0'), 'physical');
  assert.equal(nicKind('br0'), 'other');
  assert.equal(nicKind('docker0'), 'virtual');
  assert.equal(nicKind('br-9f2c'), 'virtual');
  assert.equal(nicKind('utun0'), 'virtual');
});

test('the chart defaults to the uplink but keeps a hand-picked NIC', () => {
  const names = ['docker0', 'ens192'];
  assert.equal(pickDefaultNic(names), 'ens192');
  assert.equal(pickDefaultNic(names, 'docker0'), 'docker0');
});

// A NIC that went away must not stay selected — its history is frozen, so the
// chart would keep drawing a flat line for an interface that no longer exists.
test('a NIC that disappeared is replaced by the uplink', () => {
  assert.equal(pickDefaultNic(['ens192'], 'eth9'), 'ens192');
  assert.equal(pickDefaultNic([], 'eth0'), '');
});

// ── Load average ──
test('load averages render the way uptime prints them', () => {
  assert.equal(formatLoadAverage([0.39, 0.15, 0.09]), '0.39, 0.15, 0.09');
  assert.equal(formatLoadAverage([1, 2.5, 12.3]), '1.00, 2.50, 12.30');
});

// A host that reports nothing (local sessions, older collectors) gets no row
// rather than an empty one — the caller drops the row on ''.
test('a missing load average yields no text', () => {
  assert.equal(formatLoadAverage(undefined), '');
  assert.equal(formatLoadAverage([]), '');
});

// ── Swap ──
test('swap usage is a percentage of the swap device', () => {
  assert.equal(swapPercent(1024, 256), 25);
});

// A host with no swap reports 0/0 — that is 0%, and it must not be NaN%, which
// would render an un-clamped progress bar.
test('a host with no swap at all reads 0%', () => {
  assert.equal(swapPercent(0, 0), 0);
  assert.equal(swapPercent(undefined, undefined), 0);
  assert.equal(swapPercent(0, 512), 0);
});

test('swap above the reported total is clamped to 100%', () => {
  assert.equal(swapPercent(100, 150), 100);
});

// ── Wiring ──
//
// The rows are built as one template, so their order in it is the layout:
// uptime, load, CPU, memory, swap, processes, network, disks.
test('the panel renders load, swap and the process box in that order', () => {
  const src = read('drawer-system-info.ts');
  // Only the expanded template counts: renderCompactSysInfo assigns the same
  // property earlier in the file, and the load row is precomputed above the
  // template so a plain search would compare an unrelated position.
  const fn = src.indexOf('function renderExpandedSysInfo');
  assert.ok(fn >= 0, 'renderExpandedSysInfo was not found');
  const start = src.indexOf('serverInfoEl.innerHTML = `', fn);
  assert.ok(start > fn, 'the expanded sysinfo template was not found');
  const end = src.indexOf('`;', start);
  assert.ok(end > start, 'the expanded sysinfo template has no end');
  const tpl = src.slice(start, end);

  const at = (needle: string): number => {
    const i = tpl.indexOf(needle);
    assert.ok(i >= 0, `not found in the sysinfo template: ${needle}`);
    return i;
  };
  const uptime = at("t('serverInfoUptime')");
  const load = at('${loadHtml}');
  const cpu = at("t('serverInfoCPU')");
  const mem = at("t('serverInfoMemory')");
  const swap = at("t('serverInfoSwap')");
  const procs = at('${renderProcessBox(instance)}');
  const net = at('${renderNetChart(instance)}');
  assert.ok(
    uptime < load && load < cpu && cpu < mem && mem < swap && swap < procs && procs < net,
    'load goes under uptime, swap under memory, and the process box between memory and the network chart',
  );
});

// The drawer and the panel poll on different surfaces; rendering the process
// rows into a node of their own got them wiped by the next sysinfo render, so
// they are part of the sysinfo template and rebuilt from the cached list.
test('the process box is rendered from the cached list', () => {
  const src = read('drawer-system-info.ts');
  assert.ok(
    !src.includes('renderProcessList'),
    'renderProcessList is gone — the box is part of the sysinfo template',
  );
  assert.ok(
    src.includes('const procs = instance.processes ?? []'),
    'the box must render the cached processes',
  );
  assert.match(
    src,
    /instance\.processes = \(data as ProcessListResponse\)\.processes/,
    'a processes response must be cached',
  );
});

// The process list lives in the panel now, so the panel is what has to poll it.
test('the panel polls the process list', () => {
  assert.match(
    read('server-info-panel.ts'),
    /requestServerInfo\('processes'\)/,
    'the server-info panel must request processes — nothing else does',
  );
});

test('the file drawer no longer owns the process list', () => {
  const drawer = read('drawer.ts');
  assert.ok(
    !drawer.includes("requestServerInfo('processes')"),
    'the drawer must stop polling processes',
  );
  assert.ok(!drawer.includes('process-table'), 'the drawer has no process table left');
  assert.ok(!drawer.includes('data-tab="processes"'), 'the process tab is gone');
});

// The collector and the UI read the same keys; a rename on either side leaves
// the row silently blank, which no type check catches.
test('the remote collector reports swap and load under the keys the UI reads', () => {
  for (const [key, field] of [
    ['SWAP_TOTAL', 'swap_total'],
    ['SWAP_USED', 'swap_used'],
    ['LOADAVG', 'load_avg'],
    ['CPU_TICKS', 'cpu_ticks'],
  ] as const) {
    assert.ok(
      rustSource.includes(`"${key}" =>`),
      `server_info.rs must parse ${key}`,
    );
    assert.ok(
      rustSource.includes(`info["${field}"]`),
      `server_info.rs must map ${key} onto ${field}`,
    );
    assert.ok(
      rustSource.includes(key === 'LOADAVG' ? `${key}=$(` : `${key}=`),
      `the sysinfo script must emit ${key}`,
    );
  }
});

// ── CPU usage comes from two samples, not from a remote `sleep 1` ──
//
// The script used to sample /proc/stat twice a second apart inside the SSH
// command, which held the exec channel open for a full second on every poll.
// The panel now subtracts one poll's counters from the previous one: the same
// two-reading arithmetic, over a real 5s window.

// The first poll of a session has nothing to subtract from. A placeholder is
// what the tile shows then — 0% would read as "the host is idle".
test('the first CPU sample of a session has no percentage', () => {
  assert.equal(cpuUsageFromTicks(null, [100, 10, 50, 1000, 20, 5, 3]), null);
  assert.equal(cpuUsageFromTicks(undefined, [100, 10, 50, 1000, 20, 5, 3]), null);
  assert.equal(cpuUsageFromTicks([100, 10, 50, 1000, 20, 5, 3], undefined), null);
});

// Same definition as the shell it replaced: busy is `user + system`, the
// divisor is the sum of all seven counters.
test('CPU usage is the busy share of the counter deltas', () => {
  const prev = [100, 10, 50, 1000, 20, 5, 3];
  const cur = [110, 10, 60, 1200, 20, 5, 3];
  const before = [...prev];
  const usage = cpuUsageFromTicks(prev, cur);
  assert.ok(usage !== null, 'a pair of samples must produce a number');
  assert.ok(Math.abs(usage - (20 / 220) * 100) < 1e-9, `expected 20/220, got ${usage}`);
  assert.deepEqual(prev, before, 'the inputs must not be mutated');
});

// Parity guard: nice, irq, softirq and iowait sit on the idle side of the
// ratio, exactly as in the old shell. Changing this silently redefines a number
// operators read off the panel, so it is pinned here on purpose.
test('only user and system time count as busy', () => {
  assert.equal(cpuUsageFromTicks([0, 0, 0, 0, 0, 0, 0], [0, 50, 0, 50, 50, 0, 0]), 0);
  assert.ok(Math.abs((cpuUsageFromTicks([0, 0, 0, 0, 0, 0, 0], [100, 0, 0, 100, 0, 0, 0]) ?? -1) - 50) < 1e-9);
});

// A reboot (or any counter that went backwards) makes the difference negative:
// every percentage derived from it would be fiction, so none is reported.
test('a counter that went backwards yields no percentage', () => {
  assert.equal(cpuUsageFromTicks([500, 0, 0, 900, 0, 0, 0], [10, 0, 0, 20, 0, 0, 0]), null);
});

// A vector of the wrong length cannot be mapped onto the kernel's field order,
// which is what makes a silently wrong percentage possible.
test('a counter vector of unexpected length yields no percentage', () => {
  assert.equal(cpuUsageFromTicks([1, 2, 3], [4, 5, 6]), null);
  assert.equal(cpuUsageFromTicks([1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 9]), null);
});

// No jiffies elapsed between the samples means there is no ratio to compute.
test('identical samples yield no percentage', () => {
  assert.equal(cpuUsageFromTicks([1, 2, 3, 4, 5, 6, 7], [1, 2, 3, 4, 5, 6, 7]), null);
});

// ── A metric the host cannot report is not a zero ──
//
// BusyBox `ps` has no `%CPU`/`%MEM` column at all, so the collector sends the
// unknown marker and the parser turns it into `null` instead of `0.0`. The panel
// prints whatever number it is handed, so a fabricated zero would read as
// "measured, and idle" on every row — the same kind of lie as the ranking built
// from column 3 of a format that has no column 3. `—` is what this panel already
// uses everywhere else for a value it does not have.

/** `processMetric` is a pure helper and stays unexported, so lift just its body. */
const processMetric = (() => {
  const ast = ts.createSourceFile(
    'drawer-system-info.ts', read('drawer-system-info.ts'), ts.ScriptTarget.Latest, true,
  );
  const node = ast.statements.find((n): n is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(n) && n.name?.text === 'processMetric');
  assert.ok(node, 'processMetric was not found in drawer-system-info.ts');
  // `new Function` does not strip types, so the sliced body has to be compiled
  // first — otherwise the annotation on the parameter is a syntax error.
  const js = ts.transpileModule(node!.getText(), {
    compilerOptions: { target: ts.ScriptTarget.ES2021 },
  }).outputText;
  return new Function(`${js}; return processMetric;`)() as
    (value: number | null | undefined) => { text: string; high: boolean };
})();

test('a metric the host cannot report renders as unknown, not as zero', () => {
  assert.deepEqual(processMetric(null), { text: '—', high: false });
  assert.deepEqual(processMetric(undefined), { text: '—', high: false });
});

test('a reported metric still renders to one decimal', () => {
  assert.deepEqual(processMetric(0), { text: '0.0', high: false });
  assert.deepEqual(processMetric(42.55), { text: '42.5', high: false });
});

test('the high-usage flag needs a real number above the threshold', () => {
  assert.deepEqual(processMetric(80.2), { text: '80.2', high: true });
  assert.equal(processMetric(null).high, false, 'an unknown value cannot be flagged high');
});

// Cross-language parity: Rust decides that the marker means unknown, TS decides
// that unknown prints as `—`. Neither half is visible from the other file, and a
// rename on either side degrades the panel silently rather than failing.
test('the collector sends the same marker the parser and the panel agree on', () => {
  assert.match(
    rustSource,
    /const PROCESS_LIST_CMD: &str = r#".*? - - - /s,
    'the degraded branch must send the unknown marker for the columns the host lacks',
  );
  assert.match(
    rustSource,
    /if raw == "-" \{\s*serde_json::Value::Null/,
    'and the parser must turn that marker into null rather than 0.0',
  );
});
