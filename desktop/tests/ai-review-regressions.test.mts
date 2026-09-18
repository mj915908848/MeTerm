import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { abortableOperation } from '../src/ai-abortable-operation.ts';

const source = (file: string) => ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function find(file: string, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (predicate(node)) found = node; else ts.forEachChild(node, visit); };
  visit(source(file)); assert.ok(found); return found;
}
const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS } }).outputText;
const method = (name: string) => find('ai-agent.ts', node => ts.isMethodDeclaration(node) && node.name.getText() === name).getText();

function summaryHarness() {
  const fn = find('ai-agent-compact.ts', node => ts.isFunctionDeclaration(node) && node.name?.text === 'callLLMOnce');
  const timers = new Map<number, () => void>(); let next = 0;
  const call = new Function('abortableOperation', 'setTimeout', 'clearTimeout', compile(fn.getText()) + ';return callLLMOnce;')(
    abortableOperation, (cb: () => void) => { timers.set(++next, cb); return next; }, (id: number) => timers.delete(id),
  );
  return { call, timers };
}
test('summary cancellation settles without provider callbacks and clears its deadline', async () => {
  const { call, timers } = summaryHarness(); const ctl = new AbortController(); let observed: AbortSignal;
  const pending = call({ chat: (_: unknown, __: unknown, signal: AbortSignal) => { observed = signal; } }, [], ctl.signal);
  ctl.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(observed!.aborted, true); assert.equal(timers.size, 0);
});
test('summary deadline aborts the provider and clears timers', async () => {
  const { call, timers } = summaryHarness(); let observed: AbortSignal;
  const pending = call({ chat: (_: unknown, __: unknown, signal: AbortSignal) => { observed = signal; } }, []);
  [...timers.values()][0](); await assert.rejects(pending, /timed out/);
  assert.equal(observed!.aborted, true); assert.equal(timers.size, 0);
});
test('already cancelled summary never starts; normal summary still completes', async () => {
  const { call, timers } = summaryHarness(); const ctl = new AbortController(); ctl.abort();
  await assert.rejects(call({ chat: () => assert.fail('provider started') }, [], ctl.signal), { name: 'AbortError' });
  assert.equal(await call({ chat: (_: unknown, cb: any) => cb.onComplete('summary') }, []), 'summary');
  assert.equal(timers.size, 0);
});
test('agent abort reaches the first-iteration compact controller', () => {
  const Agent = new Function('require', compile(`class Agent { ${method('abort')} }`) + ';return Agent;')(
    () => ({ cancelAllAgentTransfers: async () => {} }),
  );
  const agent = new Agent(); const ctl = new AbortController();
  agent.compactController = ctl; agent.abortController = null; agent.abort();
  assert.equal(ctl.signal.aborted, true); assert.equal(agent.compactController, null);
});

function approvalHarness() {
  const loop = find('ai-agent.ts', node => ts.isForOfStatement(node) && node.expression.getText() === 'response.toolCalls');
  const enclosing = loop.parent as ts.Block;
  const index = enclosing.statements.indexOf(loop as ts.Statement);
  const after = enclosing.statements[index + 1]; assert.ok(ts.isIfStatement(after));
  const body = `async check(response,callbacks) { const sessionId='test', iteration=1, permMode='manual', permRules=[], decisions=new Map(); const toolCtx={abortSignal:this.abortController.signal}; ${loop.getText()} ${after.getText()} }`;
  const Agent = new Function('hooks', 'decidePermission', 'abortableOperation', compile(`class Agent { ${method('completeAbortedToolBatch')} ${body} }`) + ';return Agent;')(
    { emitPreToolUse: async () => ({}) }, () => ({ kind: 'ask' }), abortableOperation,
  );
  const agent = new Agent(); agent.messages = []; agent.aborted = false;
  agent.abortController = new AbortController(); agent.toolRegistry = { get: () => ({}) };
  return agent;
}
for (const count of [1, 3]) test(`approval cancellation settles and pairs all ${count} tool calls`, async () => {
  const agent = approvalHarness();
  const calls = Array.from({ length: count }, (_, i) => ({ id: String(i), function: { name: 'run_command', arguments: '{}' } }));
  agent.messages.push({ role: 'assistant', tool_calls: calls });
  let notify: () => void; const started = new Promise<void>(resolve => { notify = resolve; });
  let aborted = 0;
  const pending = agent.check({ toolCalls: calls }, { onConfirmRequired: () => { notify!(); return new Promise(() => {}); }, onAborted: () => aborted++ });
  await started; agent.aborted = true; agent.abortController.abort(); await pending;
  assert.equal(aborted, 1);
  assert.deepEqual(agent.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id), calls.map(c => c.id));
  agent.completeAbortedToolBatch(calls, {});
  assert.equal(agent.messages.length, count + 1);
});
test('settings panel saves only the current patch after another panel changes a field', () => {
  const fn = find('settings.ts', node => ts.isFunctionDeclaration(node) && node.name?.text === 'update');
  let stored = { fontSize: 14, opacity: 1 }; const patches: any[] = [];
  const update = new Function('updateSettings', 'onSettingsChange', compile(`let current; ${fn.getText()}`) + ';return update;')(
    (patch: any) => { patches.push(patch); stored = { ...stored, ...patch }; return stored; }, () => {},
  );
  update({ fontSize: 16 }); stored.fontSize = 20; update({ opacity: 0.5 });
  assert.deepEqual(patches, [{ fontSize: 16 }, { opacity: 0.5 }]);
  assert.deepEqual(stored, { fontSize: 20, opacity: 0.5 });
});

test('cancelling approval removes the card, clears its timer and ignores late clicks', async () => {
  class Element {
    children: Element[] = []; dataset = {}; innerHTML = ''; disabled = false; removed = false;
    classList = { add: () => {} }; handlers: Record<string, () => void> = {};
    scrollTop = 0; scrollHeight = 0;
    appendChild(node: Element) { this.children.push(node); }
    querySelector() { return this.children[0]; }
    addEventListener(name: string, handler: () => void) { this.handlers[name] = handler; }
    remove() { this.removed = true; }
  }
  const fn = find('ai-capsule-tool-ui.ts', node => ts.isFunctionDeclaration(node) && node.name?.text === 'showConfirmCard');
  const timers = new Set<number>();
  const show = new Function('document', 'TOOL_COLORS', 'toolIcon', 'toolDisplayName', 'escapeHtml', 'approveIcon', 'rejectIcon', 'editIcon', 'notifyAgentWaiting', 'statusIcon', 'setTimeout', 'clearTimeout',
    compile(fn.getText().replace('export ', '')) + ';return showConfirmCard;')(
    { createElement: () => new Element() }, {}, () => '', () => '', (s: string) => s, () => '', () => '', () => '', () => {}, () => '',
    () => { timers.add(1); return 1; }, (id: number) => timers.delete(id),
  );
  const ctl = new AbortController(); const container = new Element();
  const pending = show({ agent: { cancellationSignal: ctl.signal }, chatPanel: { querySelector: () => container } }, 'run_command', { command: 'echo test' });
  const card = container.children[0]; const approve = card.children[2].children[0];
  ctl.abort(); assert.equal(await pending, false);
  assert.equal(card.removed, true); assert.equal(approve.disabled, true); assert.equal(timers.size, 0);
  approve.handlers.click(); assert.equal(await pending, false);
});
