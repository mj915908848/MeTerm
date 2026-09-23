/**
 * The latency capsule next to `● user@host` describes *that* connection, so
 * when the readout is not on screen there is nothing to measure — and nothing
 * worth measuring for. status-bar.ts must therefore:
 *
 *   - not ping the active session behind a collapsed bar (the 5s latency ping
 *     is a status-bar concern only; keepalive is TerminalRegistry's own 30s
 *     timer, so a background tab is never dropped by this),
 *   - drop the sample window and the displayed value when the bar collapses,
 *     so a reveal cannot flash a number that belongs to a previous session,
 *   - ignore pongs that were already in flight (or triggered by input on some
 *     other terminal) at the moment it collapsed.
 *
 * This is not just tidiness: on an SSH session each ping makes the backend open
 * and close a channel on the remote host (dispatch.rs::handle_ping), so a
 * hidden bar that keeps pinging touches the remote every 5s for a number
 * nobody can see.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// ─── DOM stand-in ─────────────────────────────────────────────────

class El {
  children: El[] = [];
  title = '';
  textContent = '';
  attrs: Record<string, string> = {};
  style: any = { setProperty() {} };
  parent: El | null = null;
  listeners: Record<string, ((event?: any) => void)[]> = {};
  #classes = new Set<string>();
  #html = '';

  classList = {
    add: (c: string) => { this.#classes.add(c); },
    remove: (c: string) => { this.#classes.delete(c); },
    toggle: (c: string, force?: boolean) => {
      const on = force === undefined ? !this.#classes.has(c) : force;
      if (on) this.#classes.add(c); else this.#classes.delete(c);
      return on;
    },
    contains: (c: string) => this.#classes.has(c),
  };

  // No parameter properties: `node --experimental-strip-types` only strips
  // types, it does not synthesise constructor assignments.
  tagName: string;

  constructor(tagName = 'div') {
    this.tagName = tagName;
  }

  get className(): string { return [...this.#classes].join(' '); }
  set className(value: string) { this.#classes = new Set(value.split(/\s+/).filter(Boolean)); }

  get innerHTML(): string { return this.#html; }
  set innerHTML(value: string) { this.#html = value; this.children = []; }

  get firstChild(): El | null { return this.children[0] ?? null; }
  get nextSibling(): El | null {
    if (!this.parent) return null;
    const index = this.parent.children.indexOf(this);
    return index < 0 ? null : this.parent.children[index + 1] ?? null;
  }

  appendChild(el: El): El {
    el.parent = this;
    this.children.push(el);
    return el;
  }

  insertBefore(el: El, reference: El | null): El {
    if (!reference || reference.parent !== this) return this.appendChild(el);
    el.parent = this;
    this.children.splice(this.children.indexOf(reference), 0, el);
    return el;
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  getAttribute(key: string): string | null { return this.attrs[key] ?? null; }
  querySelector(): El | null { return null; }
  querySelectorAll(): El[] { return []; }
  focus(): void {}
  blur(): void {}
  addEventListener(type: string, handler: (event?: any) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }
  removeEventListener(type: string, handler: (event?: any) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler);
  }
}

/** Depth-first search for an element whose class list contains `name`. */
function find(root: El, name: string): El | null {
  for (const child of root.children) {
    if (child.className.split(' ').includes(name)) return child;
    const nested = find(child, name);
    if (nested) return nested;
  }
  return null;
}

// ─── Harness ──────────────────────────────────────────────────────
//
// Timers are drained by hand: the ping loop and the capsule fade-out both
// schedule work that decides what the *next* assertion sees.

interface Harness {
  container: El;
  statusBar: any;
  pings: string[];
  collapsed(): boolean;
  firePong(sessionId: string, rtt: number): void;
  tick(): void;
  flushTimers(rounds?: number): void;
}

function boot(): Harness {
  const container = new El('div');
  const app = new El('div');
  const listeners: Record<string, ((event?: any) => void)[]> = {};
  const intervals: Array<() => void> = [];
  const timers = new Map<number, () => void>();
  let timerSeq = 0;

  const code = ts.transpileModule(
    readFileSync(new URL('../src/status-bar.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } },
  ).outputText;

  const exports: any = {};
  vm.runInNewContext(code, {
    exports,
    document: {
      createElement: (tag: string) => new El(tag),
      getElementById: (id: string) => (id === 'app' ? app : null),
      body: new El('body'),
      addEventListener: (type: string, handler: (event?: any) => void) => {
        (listeners[type] ??= []).push(handler);
      },
      removeEventListener: (type: string, handler: (event?: any) => void) => {
        listeners[type] = (listeners[type] ?? []).filter((h) => h !== handler);
      },
      dispatchEvent: () => true,
    },
    CustomEvent: class {
      type: string;
      detail?: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    setTimeout: (fn: () => void) => { const id = ++timerSeq; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    console,
    require: (specifier: string) => {
      if (specifier === './i18n') return { t: (key: string) => key };
      throw new Error(`unexpected import ${specifier}`);
    },
  });

  const statusBar = exports.StatusBar;
  assert.ok(statusBar, 'status-bar.ts must export the StatusBar singleton');
  statusBar.init(container);

  // The ping spy lives in this realm — only scalars cross back into the sandbox.
  const pings: string[] = [];
  statusBar.startLatencyMonitor(() => 'ssh-1', (sessionId: string) => pings.push(sessionId));

  return {
    container,
    statusBar,
    pings,
    collapsed: () => container.classList.contains('status-collapsed'),
    firePong: (sessionId: string, rtt: number) => {
      for (const handler of listeners['status-bar-pong'] ?? []) handler({ detail: { sessionId, rtt } });
    },
    tick: () => { for (const fn of intervals) fn(); },
    // Fading a capsule out is itself a scheduled step that ends in
    // updateVisibility(), so a single pass is not enough.
    flushTimers: (rounds = 3) => {
      for (let i = 0; i < rounds && timers.size > 0; i++) {
        const pending = [...timers.values()];
        timers.clear();
        for (const fn of pending) fn();
      }
    },
  };
}

// ─── Guards ───────────────────────────────────────────────────────

test('a collapsed bar never pings, not even for a live connection', () => {
  const h = boot();

  h.tick();
  assert.deepEqual(h.pings, [], 'nothing on screen, nothing to measure');

  h.statusBar.setConnection('connected', 'bruceli@192.168.0.150');
  assert.equal(h.collapsed(), true);

  h.tick();
  assert.deepEqual(h.pings, [],
    'a session that settled is not an event — no ping behind a collapsed bar');
});

test('the reveal pings at once and measuring stops again with the next collapse', () => {
  const h = boot();
  h.statusBar.setConnection('connecting', 'bruceli@192.168.0.150');
  assert.equal(h.collapsed(), false, 'a handshake in progress is worth the row');
  assert.deepEqual(h.pings, ['ssh-1'],
    'coming back on screen must not wait a whole interval for the first reading');

  h.tick();
  assert.deepEqual(h.pings, ['ssh-1', 'ssh-1'], 'and then keeps sampling while it is up');

  h.statusBar.setConnection('connected', 'bruceli@192.168.0.150');
  assert.equal(h.collapsed(), true, 'the handshake is over — back to rest');
  const settled = h.pings.length;
  h.tick();
  assert.equal(h.pings.length, settled, 'measuring stopped together with the readout');
});

test('a reading never outlives the bar it belongs to', () => {
  const h = boot();
  h.statusBar.setConnection('connected', 'bruceli@192.168.0.150');

  // Something in flight is what puts the bar (and its capsules) back on screen.
  h.statusBar.setTransfer({ direction: 'download', fileCount: 2, progress: 30 });
  assert.equal(h.collapsed(), false);

  h.firePong('ssh-1', 12);
  assert.match(h.statusBar.getConnectionTooltip(), /Latency: 12ms/);
  assert.ok(find(h.container, 'capsule-latency'), 'the reading is on screen while the bar is');

  // Transfer done → capsule fades → bar collapses.
  h.statusBar.setTransfer(null);
  h.flushTimers();
  assert.equal(h.collapsed(), true);
  assert.doesNotMatch(h.statusBar.getConnectionTooltip(), /Latency/,
    'the number goes with the bar, so the next reveal cannot pass it off as current');

  h.firePong('ssh-1', 99);
  assert.doesNotMatch(h.statusBar.getConnectionTooltip(), /Latency/,
    'a pong already in flight must not repopulate the window behind the collapsed bar');
});
