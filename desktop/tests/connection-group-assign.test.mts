/**
 * Moving several connections at once.
 *
 * A drag that carries a multi-row selection has to land as one change: the
 * per-row setters re-read and re-write the whole map on every call, so a batch
 * built out of them would re-render halfway through and could leave half the
 * selection behind if one write failed.
 *
 * connection-groups.ts is transpiled into a sandbox rather than imported, because
 * its `./connection-sort` specifier is extensionless (a bundler resolves it, node
 * does not). The real connection-sort module is handed in as the mock, so only
 * the specifier is faked, not the behaviour under test.
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

const { assignConnectionsToGroup, createGroup, listGroups, loadGroupMap } = exports;
const reset = (): void => { saved.clear(); };

// The sandbox is a separate realm, so its objects carry that realm's prototypes
// and would fail a strict structural comparison. Copy into this realm first.
const mapOf = (): Record<string, string> => ({ ...loadGroupMap() });
const groupsOf = (): string[] => [...listGroups()];

test('one call moves the whole selection', () => {
  reset();
  createGroup('prod');
  assignConnectionsToGroup(['ssh:a', 'ssh:b', 'ssh:c'], 'prod');
  assert.deepEqual(mapOf(), { 'ssh:a': 'prod', 'ssh:b': 'prod', 'ssh:c': 'prod' });
});

test('ungrouping clears the assignment for every key', () => {
  reset();
  assignConnectionsToGroup(['ssh:a', 'ssh:b'], 'prod');
  assignConnectionsToGroup(['ssh:a', 'ssh:b'], null);
  assert.deepEqual(mapOf(), {}, 'an ungrouped connection keeps no entry at all');
});

test('a partial ungroup leaves the other rows where they were', () => {
  reset();
  assignConnectionsToGroup(['ssh:a', 'ssh:b', 'ssh:c'], 'prod');
  assignConnectionsToGroup(['ssh:b'], null);
  assert.deepEqual(mapOf(), { 'ssh:a': 'prod', 'ssh:c': 'prod' });
});

test('the destination joins the order list, so a dragged-into group still renders', () => {
  reset();
  assert.deepEqual(groupsOf(), []);
  assignConnectionsToGroup(['ssh:a'], 'only-reached-by-drag');
  assert.deepEqual(groupsOf(), ['only-reached-by-drag']);
  // Moving a second batch into the same group must not duplicate it.
  assignConnectionsToGroup(['ssh:b'], 'only-reached-by-drag');
  assert.deepEqual(groupsOf(), ['only-reached-by-drag']);
});

test('an empty batch is not a write', () => {
  reset();
  assignConnectionsToGroup([], 'prod');
  assert.deepEqual(mapOf(), {});
  assert.deepEqual(groupsOf(), [], 'an empty drag must not invent a group');
});
