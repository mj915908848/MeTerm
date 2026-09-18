import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { hostsMatch, sshConversationHost } from '../src/ai-conversation-host.ts';

function harness(enabled: boolean) {
  const text = readFileSync(new URL('../src/ai-capsule.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('ai-capsule.ts', text, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(ts.isClassDeclaration)!;
  const constructor = declaration.members.find(ts.isConstructorDeclaration)!;
  const listener = constructor.body!.statements.find(node => node.getText().includes("'meterm-terminal-connected'"))!;
  const apply = declaration.members.find(node => ts.isMethodDeclaration(node) && node.name.getText() === 'applyPendingAutoOpen')!;
  let connected: (event: any) => void = () => {}; const settings = { autoOpenAiOnConnect: enabled, autoRestoreAiHistoryOnConnect: false };
  const js = ts.transpileModule(`class Manager {
    capsules=new Map(); connectedSessions=new Set(); pendingAutoOpen=new Set(); opens=[]; historyRequests=[]; _lastShownSessionId=null;
    constructor(){${listener.getText()}}
    ${apply.getText()}
    show(sid){this._lastShownSessionId=sid;this.applyPendingAutoOpen(sid)}
    openChat(inst){inst.chatOpen=true;this.opens.push(inst.id)}
    async restoreLatestHostHistory(inst){this.historyRequests.push(inst.id)}
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2021 } }).outputText;
  const Manager = new Function('document', 'loadSettings', js + ';return Manager;')(
    { addEventListener: (_: string, cb: any) => { connected = cb; } }, () => settings,
  );
  const manager = new Manager();
  const add = (id: string) => manager.capsules.set(id, { id, chatOpen: false });
  return { manager, settings, add, connect: (id: string) => connected({ detail: { sessionId: id } }) };
}

test('auto-open waits for a successful connection and only opens the active session once', () => {
  const { manager, add, connect } = harness(true); add('active'); manager.show('active');
  assert.deepEqual(manager.opens, []);
  connect('active'); assert.deepEqual(manager.opens, ['active']);
  manager.capsules.get('active').chatOpen = false;
  connect('active'); assert.deepEqual(manager.opens, ['active']); // reconnect must not override a manual close
});
test('background connection defers until shown and disabled settings never open the panel', () => {
  const { manager, add, connect, settings } = harness(false); add('disabled'); manager.show('disabled');
  connect('disabled'); assert.deepEqual(manager.opens, []);
  settings.autoOpenAiOnConnect = true; add('background'); connect('background');
  assert.deepEqual(manager.opens, []); manager.show('background'); assert.deepEqual(manager.opens, ['background']);
  add('later'); connect('later'); settings.autoOpenAiOnConnect = false; manager.show('later');
  assert.deepEqual(manager.opens, ['background']);
});
test('old settings default off and all successful transport paths announce connection', () => {
  const themes = readFileSync(new URL('../src/themes.ts', import.meta.url), 'utf8');
  assert.match(themes, /autoOpenAiOnConnect:\s*false/);
  assert.match(themes, /autoRestoreAiHistoryOnConnect:\s*false/);
  const connections = readFileSync(new URL('../src/terminal-websocket.ts', import.meta.url), 'utf8');
  assert.equal((connections.match(/'meterm-terminal-connected'/g) ?? []).length, 3);
});
test('latest history restoration is triggered only when its setting and auto-open are enabled', () => {
  const h = harness(true); h.settings.autoRestoreAiHistoryOnConnect = true;
  h.add('active'); h.manager.show('active'); h.connect('active');
  assert.deepEqual(h.manager.historyRequests, ['active']); h.connect('active');
  assert.deepEqual(h.manager.historyRequests, ['active']);
  const disabled = harness(false); disabled.settings.autoRestoreAiHistoryOnConnect = true;
  disabled.add('active'); disabled.manager.show('active'); disabled.connect('active');
  assert.deepEqual(disabled.manager.historyRequests, []);
});

function restoreHarness() {
  const text = readFileSync(new URL('../src/ai-capsule.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('ai-capsule.ts', text, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(ts.isClassDeclaration)!;
  const method = declaration.members.find(node => ts.isMethodDeclaration(node) && node.name.getText() === 'restoreLatestHostHistory')!;
  const settings = { autoOpenAiOnConnect: true, autoRestoreAiHistoryOnConnect: true };
  let currentHost = sshConversationHost('host', 22);
  let release: (convs: any[]) => void = () => {}; let loads = 0;
  const data = new Promise<any[]>(resolve => { release = resolve; });
  const js = ts.transpileModule(`class Manager {
    capsules=new Map(); _lastShownSessionId='session'; restored=[];
    ${method.getText()}
    restoreConversation(inst,conv){this.restored.push(conv);inst.currentConversationId=conv.id}
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2021 } }).outputText;
  const Manager = new Function('loadSettings', 'currentConversationHost', 'hostsMatch', 'loadConversationsFn', js + ';return Manager;')(
    () => settings, () => currentHost, hostsMatch, () => { loads++; return data; },
  );
  const manager = new Manager();
  const inst = { sessionId: 'session', currentConversationId: 'fresh', messages: [], chatOpen: true, chatHistoryOpen: false, isStreaming: false };
  manager.capsules.set(inst.sessionId, inst);
  return { manager, inst, settings, release, loads: () => loads, switchHost: () => { currentHost = sshConversationHost('other', 22); } };
}
const history = (id: string, hostBinding: any, updatedAt: number) => ({ id, hostBinding, updatedAt, messages: [{ type: 'user', content: 'goal' }] });
test('auto-restore selects the newest same-host bound conversation, never cross-host or legacy', async () => {
  const h = restoreHarness(); const pending = h.manager.restoreLatestHostHistory(h.inst);
  h.release([history('other', sshConversationHost('other', 22), 100), history('legacy', undefined, 99),
    history('old', sshConversationHost('host', 22), 1), history('latest', sshConversationHost('HOST', 22), 10),
    history('port', sshConversationHost('host', 2222), 101)]);
  await pending; assert.deepEqual(h.manager.restored.map((c: any) => c.id), ['latest']);
});
test('auto-restore leaves a fresh conversation when there is no matching history', async () => {
  const h = restoreHarness(); const pending = h.manager.restoreLatestHostHistory(h.inst);
  h.release([history('legacy', undefined, 10)]); await pending;
  assert.deepEqual(h.manager.restored, []); assert.equal(h.inst.currentConversationId, 'fresh');
});
test('auto-restore never loads history over an existing task or streaming conversation', async () => {
  for (const patch of [{ messages: [{ type: 'user', content: 'new task' }] }, { isStreaming: true }, { chatHistoryOpen: true }]) {
    const h = restoreHarness(); Object.assign(h.inst, patch);
    await h.manager.restoreLatestHostHistory(h.inst); assert.equal(h.loads(), 0);
  }
});
const changes: Record<string, (h: ReturnType<typeof restoreHarness>) => void> = {
  'conversation changed': h => { h.inst.currentConversationId = 'manual'; },
  'new message arrived': h => { (h.inst.messages as any[]).push({ type: 'user', content: 'task' }); },
  'host changed': h => h.switchHost(),
  'focus changed': h => { h.manager._lastShownSessionId = 'other'; },
  'panel closed': h => { h.inst.chatOpen = false; },
  'history opened manually': h => { h.inst.chatHistoryOpen = true; },
  'setting disabled': h => { h.settings.autoRestoreAiHistoryOnConnect = false; },
  'session destroyed': h => { h.manager.capsules.delete('session'); },
};
for (const [name, change] of Object.entries(changes)) test(`late history load does not restore when ${name}`, async () => {
  const h = restoreHarness(); const pending = h.manager.restoreLatestHostHistory(h.inst);
  change(h); h.release([history('latest', sshConversationHost('host', 22), 10)]); await pending;
  assert.deepEqual(h.manager.restored, []);
});
