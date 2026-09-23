/**
 * The status bar is on screen only while there is something to report:
 * connecting, reconnecting, a failure, a file transfer, a running AI turn.
 * A session that connected and then just sat there is not an event, so the bar
 * retracts to 0 and #app takes the 24px row back.
 *
 * History, because this has flip-flopped: v0.2.11 made the bar auto-hide;
 * 2026-09-22 whitelisted the plain `connected` state at the owner's request
 * (the readout vanishing felt like a missing feature); 2026-09-23 the owner
 * asked for the auto-hide behaviour back, explicitly as "only shows up when
 * something is wrong, stays away the rest of the time". Do not re-add
 * `connected` to the predicate below without asking again — and note the
 * latency capsule only ever renders while `connected`, so collapsing also
 * means the latency samples stop (guarded in status-bar-latency-gate.test.mts).
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
  // A freshly created element has no descendants, so `null` is the honest
  // answer — returning a throwaway El would send renderTransferCapsule() down
  // its in-place update branch and leave the capsule's markup empty, i.e. the
  // assertion below would test nothing.
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

interface Harness {
  container: El;
  app: El;
  statusBar: any;
}

function boot(): Harness {
  const container = new El('div');
  const app = new El('div');

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
      addEventListener: () => {},
      removeEventListener: () => {},
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
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    require: (specifier: string) => {
      if (specifier === './i18n') return { t: (key: string) => key };
      throw new Error(`unexpected import ${specifier}`);
    },
  });

  const statusBar = exports.StatusBar;
  assert.ok(statusBar, 'status-bar.ts must export the StatusBar singleton');
  statusBar.init(container);
  return { container, app, statusBar };
}

// ─── Guards ───────────────────────────────────────────────────────

test('a settled connection leaves the bar (and its 24px row) out of the way', () => {
  const { container, app, statusBar } = boot();

  // Nothing open yet (the home view) — the bar is collapsed.
  assert.equal(container.classList.contains('status-collapsed'), true);
  assert.equal(app.classList.contains('app-status-collapsed'), true);

  statusBar.setConnection('connected', 'bruceli@192.168.0.150');

  // A healthy session is not an event: the row goes back to #app.
  assert.equal(container.classList.contains('status-collapsed'), true,
    'a settled connection must not pin the bar on screen');
  assert.equal(app.classList.contains('app-status-collapsed'), true,
    'the reserved grid row must be reclaimed together with the bar');

  // The readout is still built and kept current in the DOM — it is the row
  // height that hides it, so the capsules are already right when the bar
  // comes back for an error or a transfer.
  const connection = find(container, 'capsule-connection');
  assert.ok(connection, 'the connection capsule must exist');
  assert.match(connection.innerHTML, /bruceli@192\.168\.0\.150/);

  statusBar.setSessionCount(4);
  const sessions = find(container, 'capsule-sessions');
  assert.ok(sessions, 'more than one session must be counted');
  assert.match(sessions.innerHTML, /4/);

  // Closing everything keeps it collapsed.
  statusBar.setConnection('disconnected');
  assert.equal(container.classList.contains('status-collapsed'), true);
  assert.equal(app.classList.contains('app-status-collapsed'), true);
});

test('the bar comes back while something is in flight, capsules and all', () => {
  const { container, statusBar } = boot();
  statusBar.setConnection('connected', 'bruceli@192.168.0.150');
  assert.equal(container.classList.contains('status-collapsed'), true);

  statusBar.setTransfer({ direction: 'upload', fileCount: 1, progress: 40 });
  assert.equal(container.classList.contains('status-collapsed'), false,
    'a transfer in flight is worth the row');

  statusBar.setLatency(3);
  const latency = find(container, 'capsule-latency');
  assert.ok(latency, 'latency must be shown while the bar is on screen');
  assert.match(latency.innerHTML, /3ms/);
  assert.match(latency.innerHTML, /latency-value good/, '3ms is a good-quality link');

  const transfer = find(container, 'capsule-transfer');
  assert.ok(transfer, 'the transfer capsule must be there');
  assert.match(transfer.innerHTML, /40%/);
});

test('a running AI turn keeps the bar on screen too', () => {
  const { container, statusBar } = boot();
  statusBar.setConnection('connected', 'bruceli@192.168.0.150');

  statusBar.setAIActive(true);
  assert.equal(container.classList.contains('status-collapsed'), false,
    'an AI turn is something happening — show it');
  assert.ok(find(container, 'capsule-ai'));
});

test('latency and session capsules stay off when they have nothing to say', () => {
  const { container, statusBar } = boot();

  // A latency reading on a dead link is meaningless.
  statusBar.setLatency(42);
  assert.equal(find(container, 'capsule-latency'), null);

  // A single session is not worth a badge.
  statusBar.setSessionCount(1);
  assert.equal(find(container, 'capsule-sessions'), null);
});

test('connecting and failing both surface the bar', () => {
  for (const status of ['connecting', 'reconnecting', 'error']) {
    const { container, statusBar } = boot();
    statusBar.setConnection(status, 'bruceli@192.168.0.150');
    assert.equal(container.classList.contains('status-collapsed'), false,
      `${status} must be visible`);
  }
});

// ─── Layout contract ──────────────────────────────────────────────

const styleSource = (name: string): string =>
  readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8');

/** Body of an exactly-anchored `selector { ... }` rule (see the harness skill). */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : '';
}

test('the bar height and the #app grid row that reserves it stay in step', () => {
  const statusCss = styleSource('status-bar.css');
  const baseCss = styleSource('base.css');

  // Guard against a silently empty read.
  assert.ok(statusCss.length > 500, 'status-bar.css must be readable');
  assert.match(baseCss, /#app\s*\{/);

  const barHeight = ruleBody(statusCss, '#status').match(/height:\s*([^;]+);/)?.[1].trim();
  assert.equal(barHeight, '24px');

  const appRows = ruleBody(baseCss, '#app').match(/grid-template-rows:\s*([^;]+);/)?.[1].trim();
  assert.equal(appRows, `33px 24px minmax(0, 1fr)`,
    'the reserved status row must equal the status bar height');

  const collapsed = ruleBody(statusCss, '#status.status-collapsed');
  assert.match(collapsed, /height:\s*0;/);

  const appCollapsed = ruleBody(baseCss, '#app.app-status-collapsed');
  assert.equal(appCollapsed.match(/grid-template-rows:\s*([^;]+);/)?.[1].trim(),
    '33px 0px minmax(0, 1fr)',
    'the collapsed grid row must be 0 so no 24px gap is left behind');
});
