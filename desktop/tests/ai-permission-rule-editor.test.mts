import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { DEFAULT_PERMISSION_RULES, validatePermissionRule } from '../src/ai-permission-rules.ts';

class Element {
  children: Element[] = [];
  className = '';
  textContent = '';
  value = '';
  placeholder = '';
  disabled = false;
  style: Record<string, string> = {};
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  validity = '';
  private html = '';
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  set innerHTML(value: string) { this.html = value; if (!value) this.children = []; }
  get innerHTML() { return this.html; }
  appendChild(child: Element) { this.children.push(child); return child; }
  addEventListener() {}
  setCustomValidity(value: string) { this.validity = value; }
  reportValidity() { return !this.validity; }
}

function editorHarness() {
  const sourceText = readFileSync(new URL('../src/settings-ai-permission.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('settings-ai-permission.ts', sourceText, ts.ScriptTarget.Latest, true);
  const fn = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'createPermissionRulesEditor');
  assert.ok(fn);
  const code = ts.transpileModule(fn.getText(source).replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const create = new Function('document', 't', 'createSettingsSelect', 'DEFAULT_PERMISSION_RULES', 'validatePermissionRule',
    `${code}\nreturn createPermissionRulesEditor;`)(
    { createElement: (tag: string) => new Element(tag) },
    (key: string) => key,
    (options: Array<{ value: string; selected?: boolean }>) => {
      const select = { el: new Element('select'), value: options.find(option => option.selected)?.value ?? options[0].value, onchange: null };
      return select;
    },
    DEFAULT_PERMISSION_RULES,
    validatePermissionRule,
  );
  const patches: Array<Record<string, unknown>> = [];
  const current = { aiPermissionRules: undefined };
  const root = create(current, (patch: Record<string, unknown>) => patches.push(patch)) as Element;
  const find = (predicate: (element: Element) => boolean, node: Element = root): Element | undefined => {
    if (predicate(node)) return node;
    for (const child of node.children) {
      const result = find(predicate, child);
      if (result) return result;
    }
  };
  return { root, patches, find };
}

test('adding a permission rule stays a draft until a tool is explicitly saved', () => {
  const { patches, find } = editorHarness();
  find(element => element.textContent === '+ aiPermissionRulesAdd')!.onclick!();
  assert.equal(patches.length, 0);
  const draft = find(element => element.className.includes('ai-permission-rule-draft'));
  assert.ok(draft);
  const save = find(element => element.textContent === 'aiPermissionRuleSave', draft);
  assert.ok(save);
  save.onclick!();
  assert.equal(patches.length, 0, 'blank tool must not become a wildcard');
  const tool = find(element => element.placeholder === 'aiPermissionRuleTool', draft)!;
  tool.value = 'run_command';
  const command = find(element => element.placeholder === 'aiPermissionRuleCmdMatch', draft)!;
  command.value = '^git status$';
  save.onclick!();
  assert.equal(patches.length, 1);
  const rules = patches[0].aiPermissionRules as Array<{ tool: string; match?: { command?: string } }>;
  assert.equal(rules.length, 1, 'Add must not write the built-in default rules as editable rows');
  assert.deepEqual(rules.at(-1), { tool: 'run_command', match: { command: '^git status$' }, action: 'ask' });
  assert.equal(rules.some(rule => rule.tool === 'run_command' && !rule.match), false);
  const saved = find(element => element.className === 'ai-permission-rule-row'
    && element.children[1]?.value === '^git status$')!;
  const savedTool = saved.children[0];
  savedTool.value = '';
  savedTool.onchange!();
  assert.equal(patches.length, 1, 'clearing a tool must not silently turn it into *');
  assert.equal(savedTool.value, 'run_command');
});

test('cancelling a new permission rule leaves settings untouched', () => {
  const { patches, find } = editorHarness();
  find(element => element.textContent === '+ aiPermissionRulesAdd')!.onclick!();
  find(element => element.textContent === 'aiPermissionRuleCancel')!.onclick!();
  assert.equal(patches.length, 0);
  assert.equal(find(element => element.className.includes('ai-permission-rule-draft')), undefined);
});

test('invalid draft regex cannot be saved', () => {
  const { patches, find } = editorHarness();
  find(element => element.textContent === '+ aiPermissionRulesAdd')!.onclick!();
  const draft = find(element => element.className.includes('ai-permission-rule-draft'))!;
  find(element => element.placeholder === 'aiPermissionRuleTool', draft)!.value = 'run_command';
  const path = find(element => element.placeholder === 'aiPermissionRulePathMatch', draft)!;
  path.value = '[';
  find(element => element.textContent === 'aiPermissionRuleSave', draft)!.onclick!();
  assert.equal(patches.length, 0);
  assert.notEqual(path.validity, '');
});
