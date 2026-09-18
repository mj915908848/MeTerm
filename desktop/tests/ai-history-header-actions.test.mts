import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const ast = ts.createSourceFile('ops.ts', readFileSync(new URL('../src/ai-capsule-chat-ops.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS } }).outputText;
const helper = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'leaveHeaderHistoryView')!;
function callback(button: string) {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === button + '.addEventListener') found = node.arguments[1];
    else ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(found); return found.getText(ast);
}
function harness(button: string, split = false) {
  const messages = { style: { display: 'none' }, innerHTML: 'old' };
  const history = { style: { display: '' } };
  let previewRemoved = false;
  const panel = { querySelector: (selector: string) => selector === '.ai-chat-messages' ? messages
    : selector === '.ai-side-chat-history-view' ? history
    : selector === '.ai-history-preview-drawer' ? { remove: () => { previewRemoved = true; } } : null };
  let cleared = 0; let rendered = 0;
  const active = { isStreaming: false, chatHistoryOpen: true, currentConversationId: 'original', messages: [{ content: 'keep' }],
    conversationHost: { kind: 'local' }, streamMsgEl: {}, streamBuffer: 'partial', reasoningBuffer: 'partial', agent: { clear: () => { cleared++; } } };
  const owner = split ? { ...active } : active;
  const saved: any[] = []; const deleted: string[] = []; const closed: any[] = [];
  const host = { closeChatHistory: (inst: any) => { closed.push(inst); inst.chatHistoryOpen = false; },
    saveConversation: async (_: any, snapshot: any) => { saved.push(snapshot); },
    deleteConversation: async (id: string) => { deleted.push(id); }, updateChatTitle() {} };
  const action = new Function('currentInstance', 'instance', 'panel', 'host', 'clearPendingAttachments', 'maybeRenderEmptyState',
    compile(helper.getText(ast) + '\nconst action = ' + callback(button) + ';') + ';return action;')(
    () => active, owner, panel, host, () => {}, () => { rendered++; },
  );
  return { action, active, owner, messages, history, saved, deleted, closed,
    get cleared() { return cleared; }, get rendered() { return rendered; }, get previewRemoved() { return previewRemoved; } };
}
test('new conversation exits history and saves the previous conversation with its binding', () => {
  const h = harness('newChatBtn'); h.action();
  assert.equal(h.active.chatHistoryOpen, false); assert.equal(h.history.style.display, 'none');
  assert.equal(h.messages.style.display, ''); assert.equal(h.messages.innerHTML, ''); assert.equal(h.rendered, 1);
  assert.equal(h.previewRemoved, true); assert.equal(h.saved[0].id, 'original');
  assert.deepEqual(h.saved[0].hostBinding, { kind: 'local' }); assert.equal(h.saved[0].messages.length, 1);
  assert.equal(h.deleted.length, 0); assert.notEqual(h.active.currentConversationId, 'original');
});
test('clear conversation exits history and deletes only the active conversation', () => {
  const h = harness('clearBtn'); h.action();
  assert.deepEqual(h.deleted, ['original']); assert.equal(h.saved.length, 0);
  assert.equal(h.active.messages.length, 0); assert.equal(h.active.conversationHost, undefined);
  assert.equal(h.active.streamMsgEl, null); assert.equal(h.active.streamBuffer, ''); assert.equal(h.active.reasoningBuffer, '');
  assert.equal(h.messages.style.display, ''); assert.equal(h.rendered, 1);
});
test('shared panel actions close both history owners after a focused-pane change', () => {
  const h = harness('newChatBtn', true); h.action();
  assert.deepEqual(h.closed, [h.active, h.owner]); assert.equal(h.owner.chatHistoryOpen, false);
});
test('header actions preserve active streaming tasks', () => {
  for (const button of ['newChatBtn', 'clearBtn']) {
    const h = harness(button); h.active.isStreaming = true; h.action();
    assert.equal(h.cleared, 0); assert.equal(h.closed.length, 0); assert.equal(h.deleted.length, 0);
    assert.equal(h.saved.length, 0); assert.equal(h.previewRemoved, false);
  }
});
