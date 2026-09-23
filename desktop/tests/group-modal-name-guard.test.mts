/**
 * The group dialog has to refuse a reserved name *visibly*.
 *
 * `createGroup` / `renameGroup` refuse names in the app's `__` namespace (see
 * `isReservedGroupName`), and `connection-group-names.test.mts` pins that refusal.
 * But a dialog that accepts the name and closes on it turns a refusal into the
 * exact silent failure the refusal exists to prevent: the group is not created,
 * nothing says why, and the user is left believing it was.
 *
 * So this test drives the real `showGroupModal` and checks the two halves that
 * only exist in the UI: the message appears and the dialog stays open on a
 * reserved name, and a legitimate name still goes through and closes.
 *
 * `home-dashboard-left.ts` is transpiled into a sandbox because its imports are
 * extensionless (a bundler resolves them, node does not). Its `./connection-groups`
 * import is the *real* module, transpiled into a nested sandbox too — otherwise
 * this test would be checking the dialog against a re-implementation of the
 * predicate rather than the predicate the app ships.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as connectionSort from '../src/connection-sort.ts';

const SRC = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const ES2021 = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } as const;

// `connection-sort.ts` is imported for real and reads the bare global
// `localStorage`, so the store has to exist in this realm as well as in the
// sandboxes (which receive it as a context global).
const saved = new Map<string, string>();
const stubStorage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => { saved.set(key, value); },
  removeItem: (key: string) => { saved.delete(key); },
};
Object.defineProperty(globalThis, 'localStorage', { value: stubStorage, configurable: true });

/** Minimal element: enough for the modal's tree, and it records its own removal. */
class El {
  children: El[] = [];
  textContent = '';
  placeholder = '';
  type = '';
  value = '';
  hidden = false;
  style: Record<string, string> = {};
  onclick?: () => void;
  oninput?: () => void;
  onkeydown?: (e: { key: string; preventDefault(): void }) => void;
  removed = false;
  private parent: El | null = null;
  private names = new Set<string>();

  get className(): string { return [...this.names].join(' '); }
  set className(value: string) { this.names = new Set(value.split(/\s+/).filter(Boolean)); }
  classList = {
    add: (c: string) => { this.names.add(c); },
    remove: (c: string) => { this.names.delete(c); },
    contains: (c: string) => this.names.has(c),
  };
  appendChild(el: El): El { el.parent = this; this.children.push(el); return el; }
  remove(): void { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  querySelectorAll(): El[] { return []; }
  focus(): void {}
  select(): void {}
  blur(): void {}
}

/** Depth-first search by class, over a stubbed tree. */
function byClass(root: El, cls: string): El | undefined {
  for (const child of root.children) {
    if (child.classList.contains(cls)) return child;
    const found = byClass(child, cls);
    if (found) return found;
  }
  return undefined;
}

/** Run one `showGroupModal` in a fresh realm and hand back its tree. */
function openModal(currentName: string, currentColor = ''): {
  body: El;
  input: El;
  confirm: El;
  error: El;
  overlay: El;
  confirmed: { name: string; color: string }[];
} {
  // The real group store (needed for `isReservedGroupName`).
  const groupExports: any = {};
  vm.runInNewContext(ts.transpileModule(SRC('src/connection-groups.ts'), { compilerOptions: ES2021 }).outputText, {
    exports: groupExports,
    localStorage: stubStorage,
    require: (specifier: string) => {
      if (specifier === './connection-sort') return connectionSort;
      throw new Error(`connection-groups: unexpected import ${specifier}`);
    },
  });

  const body = new El();
  const noop = (): void => {};
  const mocks: Record<string, any> = {
    './app-state': { settings: { language: 'zh' } },
    './i18n': { t: (key: string) => key },
    './icons': { icon: () => '' },
    './notify': { showToast: noop },
    './overlay-scrollbar': { createOverlayScrollbar: noop },
    './development-credential-recovery-ui': { appendSshConnectionMenuItems: noop },
    './home-dashboard-card-order': { loadCardOrder: () => [], saveCardOrder: noop },
    './home-card-width': { clearCardWidth: noop, dragCardWidth: noop, loadCardWidths: () => ({}), setCardWidth: noop },
    './connection-sort': connectionSort,
    './connection-groups': groupExports,
    './ssh': {
      loadSavedConnections: () => [], loadRecentConnections: () => [], removeRecentConnection: noop,
      showSSHModal: noop, removeConnection: noop, getSSHConnectHandler: () => null,
    },
    './remote': {
      loadSavedRemoteConnections: () => [], loadRecentRemoteConnections: () => [], removeRecentRemoteConnection: noop,
      showRemoteEditDialog: noop, showRemoteCardSessionPopup: noop, removeRemoteConnection: noop,
    },
    './jumpserver-api': { loadJumpServerConfigs: () => [], removeJumpServerConfig: noop },
  };

  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(SRC('src/home-dashboard-left.ts'), { compilerOptions: ES2021 }).outputText, {
    exports,
    document: { createElement: () => new El(), body },
    // The focus/select deferral at the end of the modal; run nothing so the test
    // does not leave a timer behind.
    setTimeout: noop,
    require: (specifier: string) => {
      if (!mocks[specifier]) throw new Error(`home-dashboard-left: unexpected import ${specifier}`);
      return mocks[specifier];
    },
  });

  const confirmed: { name: string; color: string }[] = [];
  exports.showGroupModal(currentName, currentColor, (name: string, color: string) => { confirmed.push({ name, color }); });

  const overlay = body.children[0];
  return {
    body,
    overlay,
    input: byClass(overlay, 'group-modal-input')!,
    confirm: byClass(overlay, 'group-modal-btn-primary')!,
    error: byClass(overlay, 'group-modal-error')!,
    confirmed,
  };
}

test('a reserved name keeps the dialog open and says why', () => {
  const m = openModal('');
  assert.equal(m.error.hidden, true, 'nothing to complain about before the user commits');

  m.input.value = '__type:ssh';
  m.confirm.onclick!();

  assert.deepEqual(m.confirmed, [], 'the dialog must not hand a reserved name on to be created');
  assert.equal(m.overlay.removed, false, 'and must not close — closing is what makes the refusal silent');
  assert.equal(m.error.hidden, false, 'the reason has to be on screen');
  assert.equal(
    m.error.textContent,
    'homeGroupNameReserved',
    'the message must be the reserved-name key, not a generic failure',
  );
  assert.equal(m.input.value, '__type:ssh', 'the rejected name stays so the user can edit it');
});

test('the message clears as soon as the user edits the name', () => {
  const m = openModal('');
  m.input.value = '__ungrouped__';
  m.confirm.onclick!();
  assert.equal(m.error.hidden, false);

  m.input.oninput!();
  assert.equal(m.error.hidden, true, 'a stale error next to a corrected name is its own confusion');
});

test('an ordinary name still creates the group and closes', () => {
  const m = openModal('');
  m.input.value = '  prod  ';
  m.confirm.onclick!();

  assert.deepEqual(
    m.confirmed,
    [{ name: 'prod', color: '' }],
    'a normal name goes through, trimmed, with the picked colour',
  );
  assert.equal(m.overlay.removed, true);
  assert.equal(m.error.hidden, true);
});

test('an empty name is still ignored without complaining', () => {
  const m = openModal('');
  m.input.value = '   ';
  m.confirm.onclick!();

  assert.deepEqual(m.confirmed, []);
  assert.equal(m.overlay.removed, false);
  assert.equal(m.error.hidden, true, 'a blank is not a reserved name — it is just not a name yet');
});

test('renaming onto a reserved name is refused the same way', () => {
  const m = openModal('prod', '#3b82f6');
  assert.equal(m.input.value, 'prod', 'the dialog opens on the current name');

  m.input.value = '__type:ssh';
  m.confirm.onclick!();
  assert.deepEqual(m.confirmed, []);
  assert.equal(m.error.hidden, false);

  m.input.value = 'production';
  m.confirm.onclick!();
  assert.deepEqual(m.confirmed, [{ name: 'production', color: '#3b82f6' }]);
  assert.equal(m.overlay.removed, true);
});
