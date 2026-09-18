import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

const read = (file: string) => readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
function extract(file: string, name: string) {
  const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node); return node.getText(ast).replace(/^export\s+/, '');
}
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
}).outputText;

test('only the settings implementation can perform whole-object saves', () => {
  for (const file of readdirSync(new URL('../src/', import.meta.url)).filter(f => f.endsWith('.ts') && f !== 'themes.ts')) {
    const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) assert.notEqual(node.expression.getText(ast), 'saveSettings', file);
      if (ts.isImportSpecifier(node)) assert.notEqual((node.propertyName ?? node.name).text, 'saveSettings', file);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const ast = ts.createSourceFile('themes.ts', read('themes.ts'), ts.ScriptTarget.Latest, true);
  const save = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'saveSettings') as ts.FunctionDeclaration;
  assert.ok(save); assert.equal(save.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false, false);
});

test('sequential patches preserve unrelated fields from the latest persisted settings', () => {
  let persisted = { fontSize: 14, autoOpenAiOnConnect: false, sidebarWidth: 240 };
  const update = new Function('loadSettings', 'saveSettings', compile(extract('themes.ts', 'updateSettings')) + ';return updateSettings;')(
    () => ({ ...persisted }), (next: typeof persisted) => { persisted = { ...next }; },
  );
  const oldSnapshot = { ...persisted };
  update({ autoOpenAiOnConnect: true });
  const next = update({ fontSize: oldSnapshot.fontSize + 1 });
  assert.equal(next.autoOpenAiOnConnect, true);
  assert.equal(next.fontSize, 15);
  update({ sidebarWidth: 320 }); assert.equal(persisted.autoOpenAiOnConnect, true);
});

test('font shortcut reads fresh settings and updates app state before applying terminal settings', async () => {
  const ast = ts.createSourceFile('keyboard-shortcuts.ts', read('keyboard-shortcuts.ts'), ts.ScriptTarget.Latest, true);
  let block: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(ast) === 'isIncrease || isDecrease || isReset') block = node;
    else ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(block);
  let persisted = { fontSize: 20, autoOpenAiOnConnect: true };
  let applied: unknown;
  // The production binding is live; expose it through a closure rather than a stale copy.
  const code = compile('async function run() { const isIncrease=true,isDecrease=false,isReset=false; const event={preventDefault(){},stopPropagation(){},stopImmediatePropagation(){}}; ' + block!.getText(ast) + ' }');
  const liveRun = new Function('loadSettings', 'updateSettings', 'TerminalRegistry', 'requestAnimationFrame',
    'let settings; const setSettings = next => { settings = next; }; ' + code + ';return run;')(
    () => ({ ...persisted }), (patch: Partial<typeof persisted>) => ({ ...persisted, ...patch }),
    { setSettings: async (next: unknown) => { applied = next; }, resizeAll() {} }, (fn: () => void) => fn(),
  );
  await liveRun(); assert.deepEqual(applied, { fontSize: 21, autoOpenAiOnConnect: true });
});

test('theme application does not overwrite a newer font size or color preference', () => {
  let persisted = { fontSize: 22, colorScheme: 'light', theme: 'old', fileManagerFontSize: 16, autoOpenAiOnConnect: true };
  let applied: unknown;
  const apply = new Function('loadSettings', 'updateSettings', 'resolveThemeAttr', 'getEffectiveTheme', 'TerminalRegistry', 'document',
    compile(extract('appearance.ts', 'applyColorScheme')) + ';return applyColorScheme;')(
    () => ({ ...persisted }), (patch: Partial<typeof persisted>) => { persisted = { ...persisted, ...patch }; return persisted; },
    (scheme: string) => scheme, () => 'defaultLight', { setSettings: (s: unknown) => { applied = { ...(s as object) }; } },
    { documentElement: { dataset: {}, style: { setProperty() {} } } },
  );
  apply({ fontSize: 14, colorScheme: 'dark', theme: 'old' });
  assert.equal(persisted.fontSize, 22); assert.equal(persisted.colorScheme, 'light');
  assert.deepEqual(applied, persisted);
});
