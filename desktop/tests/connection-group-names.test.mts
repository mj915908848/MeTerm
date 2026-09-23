/**
 * Group names the app reserves for itself.
 *
 * Every internal id in this feature lives in the `__` namespace and is compared
 * **by value**: `__ungrouped__` is the sentinel bucket for connections that
 * belong to no group (`home-side.ts`, `connection-drag.ts`, `connection-sort.ts`)
 * and `__type:<kind>` is the dashboard's id for the per-kind cards it draws out
 * of that bucket (`home-dashboard-left.ts`).
 *
 * Letting a user take one is not a cosmetic problem — it is a reachability
 * problem, and it fails silently:
 *
 *   - a group named `__type:ssh` is filtered out by `loadGroupOrder`, so the
 *     dashboard, which builds its cards from that list, never draws it and the
 *     connections assigned to it disappear from the dashboard;
 *   - a group named `__ungrouped__` is indistinguishable from "no group", so its
 *     rows merge into the root bucket and the group itself never appears.
 *
 * The first test demonstrates both harms against the real store (writing the
 * order straight into storage, the way a pre-fix build would have), so the
 * refusals asserted after it are provably load-bearing rather than defensive.
 *
 * connection-groups.ts is transpiled into a sandbox rather than imported, because
 * its `./connection-sort` specifier is extensionless (a bundler resolves it, node
 * does not). The real module is handed in as the mock, so only the specifier is
 * faked, not the behaviour.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as connectionSort from '../src/connection-sort.ts';

const saved = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => saved.set(key, value),
  removeItem: (key: string) => saved.delete(key),
};
// `connection-sort.ts` is imported as a *real* module (not sandboxed), and
// `renameGroup` calls its `migrateGroupSort`, which reads the bare global
// `localStorage`. Point it at the same stub the sandbox gets, so a rename moves
// the saved sort in one store rather than reaching for a global node has none of.
Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true });

const code = ts.transpileModule(
  readFileSync(new URL('../src/connection-groups.ts', import.meta.url), 'utf8'),
  // Transpile at the project's target (tsconfig: ES2021). At the ES5 default TS
  // downlevels iterator spreads into a `.length`-based loop, which silently
  // yields nothing for a Set/Map — the harness has to match the real build.
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } },
).outputText;

const exports: any = {};
vm.runInNewContext(code, {
  exports,
  localStorage,
  require: (specifier: string) => {
    if (specifier === './connection-sort') return connectionSort;
    throw new Error(`unexpected import ${specifier}`);
  },
});

const { createGroup, renameGroup, isReservedGroupName, listGroups, loadGroupMap } = exports;
const reset = (): void => { saved.clear(); };

const ORDER_KEY = 'meterm-connection-group-order';
const MAP_KEY = 'meterm-connection-groups';
// The sandbox is a separate realm, so its objects carry that realm's prototypes
// and would fail a strict structural comparison. Copy into this realm first.
const groupsOf = (): string[] => [...listGroups()];
const mapOf = (): Record<string, string> => ({ ...loadGroupMap() });

/**
 * The harm, not the theory. Both are written straight into storage — bypassing
 * `createGroup` — exactly as a store written before the refusal existed would
 * look, so this test keeps describing reality rather than a hypothetical.
 */
test('a reserved name really is unreachable — which is why it is refused', () => {
  reset();
  saved.set(ORDER_KEY, JSON.stringify(['prod', '__type:ssh']));
  saved.set(MAP_KEY, JSON.stringify({ 'ssh:a': '__type:ssh', 'ssh:b': 'prod' }));

  assert.deepEqual(
    groupsOf(),
    ['prod'],
    '`__type:ssh` is filtered out of the order, so the dashboard — which draws one card per '
    + 'entry in this list — never renders it. `ssh:a` is still assigned to it and so appears '
    + 'in no dashboard card at all: the connection is effectively lost from that view.',
  );
  assert.equal(mapOf()['ssh:a'], '__type:ssh', 'the assignment is still there, it just has no card');

  // A connection filed under the ungrouped sentinel is the same shape of loss:
  // the key is a real value in the map, but every consumer reads it as "no group".
  reset();
  saved.set(MAP_KEY, JSON.stringify({ 'ssh:a': '__ungrouped__' }));
  assert.deepEqual(groupsOf(), [], 'nothing was ever added to the order for it');
  assert.equal(mapOf()['ssh:a'], '__ungrouped__');
});

test('the reserved namespace is exactly what the app compares by value', () => {
  // The predicate has to cover every sentinel the rest of the feature compares
  // against, or a chosen name slips past the refusal and hits the harm above.
  for (const sentinel of ['__ungrouped__', '__type:ssh', '__type:remote', '__type:jumpserver']) {
    assert.equal(isReservedGroupName(sentinel), true, `${sentinel} is an internal id`);
  }
  // And the consumers still spell them this way — a rename there without one
  // here would leave the predicate guarding a name nobody uses.
  const sentinels = [
    ['src/home-side.ts', "const UNGROUPED = '__ungrouped__'"],
    ['src/connection-drag.ts', "const UNGROUPED = '__ungrouped__'"],
    ['src/connection-sort.ts', "const UNGROUPED_GROUP = '__ungrouped__'"],
    ['src/connection-groups.ts', "startsWith('__type:')"],
    ['src/home-dashboard-left.ts', 'card.dataset.groupName = `__type:${type}`'],
  ] as const;
  for (const [rel, fragment] of sentinels) {
    const source = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    assert.ok(source.includes(fragment), `${rel} must still use ${fragment}`);
  }

  // Ordinary names are untouched, including ones that merely contain underscores.
  for (const name of ['prod', 'staging', '_draft', 'my_group', '__', '']) {
    assert.equal(isReservedGroupName(name), name.startsWith('__'));
  }
});

test('a group cannot be created with a reserved name', () => {
  reset();
  assert.equal(createGroup('prod'), true);
  assert.equal(createGroup('__type:ssh'), false, 'the create must be refused, not just reported');
  assert.equal(createGroup('__ungrouped__'), false);

  assert.deepEqual(
    groupsOf(),
    ['prod'],
    'a refused create must write nothing — accepting the name and then losing the group is the '
    + 'exact failure this prevents',
  );
});

test('a group cannot be renamed into the reserved namespace', () => {
  reset();
  createGroup('prod');
  const { assignConnectionsToGroup } = exports;
  assignConnectionsToGroup(['ssh:a', 'ssh:b'], 'prod');

  assert.equal(renameGroup('prod', '__type:ssh'), false);
  assert.equal(renameGroup('prod', '__ungrouped__'), false);

  assert.deepEqual(groupsOf(), ['prod'], 'the group keeps its name');
  assert.deepEqual(
    mapOf(),
    { 'ssh:a': 'prod', 'ssh:b': 'prod' },
    'and its connections keep pointing at it. A rename that went through would re-point every '
    + 'row at a name the app reads as one of its own sentinels — unaddressable, not just mislabelled',
  );
});

test('ordinary renames still work, and a no-op rename is not an error', () => {
  reset();
  createGroup('prod');
  exports.assignConnectionsToGroup(['ssh:a'], 'prod');

  assert.equal(renameGroup('prod', 'production'), true);
  assert.deepEqual(groupsOf(), ['production']);
  assert.deepEqual(mapOf(), { 'ssh:a': 'production' });

  assert.equal(renameGroup('production', 'production'), true, 'renaming to itself is a no-op, not a failure');
  assert.deepEqual(groupsOf(), ['production'], 'and it must not duplicate the entry');
});
