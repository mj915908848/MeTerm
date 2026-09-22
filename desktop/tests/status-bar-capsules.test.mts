/**
 * The status bar is what tells you *which machine you are on*, how far away it
 * is, and how many sessions you have open — user@host, latency, session count.
 *
 * It used to be permanently visible. A later refactor made the whole bar
 * auto-hide and forgot to whitelist the plain `connected` state, so the moment a
 * session settled down the bar collapsed to 0 and all three capsules went with
 * it. The connection still worked; the readout just disappeared. These guards
 * pin the visibility rule and the capsule contents that depend on it.
 *
 * The bar only collapses when there is genuinely nothing to describe — no
 * session at all (the home view). Everything else keeps it on screen.
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
  querySelector(): El { return new El(); }
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

test('a settled connection keeps the bar and its three capsules on screen', () => {
  const { container, app, statusBar } = boot();

  // Nothing open yet (the home view) — the bar stays collapsed.
  assert.equal(container.classList.contains('status-collapsed'), true);
  assert.equal(app.classList.contains('app-status-collapsed'), true);

  statusBar.setConnection('connected', 'bruceli@192.168.0.150');

  // Connected is a state worth describing: the bar must come back.
  assert.equal(container.classList.contains('status-collapsed'), false,
    'a connected session must not collapse the status bar');
  assert.equal(app.classList.contains('app-status-collapsed'), false,
    'the #app grid row must be restored with the bar');

  const connection = find(container, 'capsule-connection');
  assert.ok(connection, 'the connection capsule must exist');
  assert.match(connection.innerHTML, /bruceli@192\.168\.0\.150/);

  statusBar.setLatency(3);
  const latency = find(container, 'capsule-latency');
  assert.ok(latency, 'latency must be shown while connected');
  assert.match(latency.innerHTML, /3ms/);
  assert.match(latency.innerHTML, /latency-value good/, '3ms is a good-quality link');

  statusBar.setSessionCount(4);
  const sessions = find(container, 'capsule-sessions');
  assert.ok(sessions, 'more than one session must be counted');
  assert.match(sessions.innerHTML, /4/);

  // Closing everything retracts the bar again.
  statusBar.setConnection('disconnected');
  assert.equal(container.classList.contains('status-collapsed'), true);
  assert.equal(app.classList.contains('app-status-collapsed'), true);
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
