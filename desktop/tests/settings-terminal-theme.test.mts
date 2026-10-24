import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const src = readFileSync(new URL('../src/themes.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('themes.ts', src, ts.ScriptTarget.Latest, true);
const fn = (name: string) => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast).replace(/^export\s+/, '');
};
const code = ts.transpileModule(
  ['getEffectiveTheme', 'validTerminalTheme', 'splitTerminalTheme'].map(fn).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS } },
).outputText;

const THEMES = {
  default: { type: 'dark' }, defaultLight: { type: 'light' }, dracula: { type: 'dark' },
  solarized: { type: 'dark' }, solarizedLight: { type: 'light' },
};
const PAIRS = { default: 'defaultLight', defaultLight: 'default', solarized: 'solarizedLight', solarizedLight: 'solarized' };
const resolveIsDark = (scheme: string) => scheme !== 'light';
const { getEffectiveTheme, splitTerminalTheme } = new Function('THEMES', 'DARK_LIGHT_PAIRS', 'resolveIsDark',
  code + ';return { getEffectiveTheme, splitTerminalTheme };')(THEMES, PAIRS, resolveIsDark);

test('each appearance keeps its own terminal theme', () => {
  const s = { terminalThemeDark: 'dracula', terminalThemeLight: 'solarizedLight' };
  assert.equal(getEffectiveTheme({ ...s, colorScheme: 'darker' }), 'dracula');
  assert.equal(getEffectiveTheme({ ...s, colorScheme: 'light' }), 'solarizedLight');
  // Back to dark: the dark choice was never overwritten.
  assert.equal(getEffectiveTheme({ ...s, colorScheme: 'dark' }), 'dracula');
});

test('a theme of the wrong type falls back to that appearance default', () => {
  assert.equal(getEffectiveTheme({ terminalThemeDark: 'defaultLight', terminalThemeLight: 'dracula', colorScheme: 'dark' }), 'default');
  assert.equal(getEffectiveTheme({ terminalThemeDark: 'x', terminalThemeLight: 'missing', colorScheme: 'light' }), 'defaultLight');
});

test('upgrading seeds both slots from the single old theme', () => {
  assert.deepEqual(splitTerminalTheme('dracula'), ['dracula', 'defaultLight']);
  assert.deepEqual(splitTerminalTheme('solarizedLight'), ['solarized', 'solarizedLight']);
  assert.deepEqual(splitTerminalTheme('missing'), ['default', 'defaultLight']);
  assert.deepEqual(splitTerminalTheme(''), ['default', 'defaultLight']);
});
