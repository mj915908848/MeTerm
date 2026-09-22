import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * Panel ↔ toolbar highlight sync.
 *
 * The AI chat side panel and the JumpServer panel can each be opened/closed
 * from several places — the panel's own header ✕, a toolbar button, the
 * toolbar dropdown, Esc, a logout teardown — while the toolbar button is a
 * *second view* of the same flag. Every path (not just the toolbar itself)
 * therefore has to announce the transition, otherwise the button keeps its
 * highlight after the panel is gone.
 *
 * These tests drive the real transition functions with stubbed collaborators
 * and assert the announcement fires exactly once per real state change, and
 * never for a no-op (closing an already-closed panel, re-opening an open one).
 * The last two tests pin the cross-module contract: the announcer and the
 * toolbar never import each other, so only a source guard can catch a rename.
 */

const read = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

function fnSource(file: string, name: string): string {
  const text = read(file);
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  assert.ok(node, `${file} no longer declares ${name}()`);
  // `getText()` keeps the `export` keyword, which is only valid in a module —
  // the extracted source is injected into a `new Function` body instead.
  return node!.getText().replace(/^export\s+/, '');
}

const compile = (source: string): string =>
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021 } }).outputText;

// strip-only mode cannot compile parameter properties, so the sandbox event
// stub assigns its fields explicitly.
class FakeEvent {
  type: string;
  detail: unknown;
  constructor(type: string, detail?: unknown) {
    this.type = type;
    this.detail = detail;
  }
}

// ─── AI chat side panel (ai-capsule-chat-ops.ts) ─────────────

function aiChatHarness() {
  const code = compile(
    ['openChat', 'minimizeChat', 'closeChatAndSave']
      .map((name) => fnSource('ai-capsule-chat-ops.ts', name))
      .join('\n'),
  );

  const notifications: Array<{ chatOpen: boolean; chatMinimized: boolean }> = [];
  const noop = (): void => {};
  const fakePanel = () => ({ style: {} as Record<string, string>, querySelector: () => null });

  const makeInstance = (patch: Record<string, unknown> = {}) => ({
    sessionId: 'session-a',
    tabId: 'tab-a',
    layoutMode: 'side',
    chatOpen: false,
    chatMinimized: false,
    isStreaming: false,
    messages: [] as unknown[],
    currentConversationId: 'conv-1',
    conversationHost: undefined,
    chatPanel: fakePanel(),
    element: { classList: { add: noop, remove: noop } },
    agent: { clear: noop, abort: noop },
    streamMsgEl: null,
    streamBuffer: '',
    reasoningBuffer: '',
    ...patch,
  });

  // The announcement must observe the *new* state, because the toolbar reads
  // the flag synchronously when it repaints.
  let current: { chatOpen: boolean; chatMinimized: boolean } = { chatOpen: false, chatMinimized: false };
  const host = {
    notifyChatToggled: () => notifications.push({
      chatOpen: current.chatOpen,
      chatMinimized: current.chatMinimized,
    }),
    updateButtonHighlight: noop,
    updateChatTitle: noop,
    closeHistory: noop,
    closeChatHistory: noop,
    saveConversation: () => Promise.resolve(),
    deleteConversation: () => Promise.resolve(),
    injectUserMessage: noop,
  };

  const api = new Function(
    'TerminalRegistry', 'syncBarPlaceholder', 'hideSidePanel', 'createChatPanel',
    'attachPersistentTodoListener', 'renderTodoBoardImport', 'maybeRenderEmptyState',
    'switchToSideMode', 'getSideInputCallbacks', 'document', 'CustomEvent',
    `${code}; return { openChat, minimizeChat, closeChatAndSave };`,
  )(
    { resizeAll: noop },
    noop,                       // syncBarPlaceholder
    noop,                       // hideSidePanel
    () => fakePanel(),          // createChatPanel
    noop,                       // attachPersistentTodoListener
    noop,                       // renderTodoBoardImport
    noop,                       // maybeRenderEmptyState
    noop,                       // switchToSideMode
    () => ({}),                 // getSideInputCallbacks
    { dispatchEvent: noop },    // document
    FakeEvent,
  );

  const instance = (patch: Record<string, unknown> = {}) => {
    const inst = makeInstance(patch);
    current = inst as unknown as { chatOpen: boolean; chatMinimized: boolean };
    return inst;
  };

  return { api, host, notifications, instance };
}

test('opening the AI chat panel announces the transition once, with the new state', () => {
  const h = aiChatHarness();
  const inst = h.instance({ chatPanel: null }); // no panel DOM yet — the real open path creates it
  h.api.openChat(inst, h.host);

  assert.equal(inst.chatOpen, true);
  assert.deepEqual(h.notifications, [{ chatOpen: true, chatMinimized: false }]);
});

test('minimizing and closing the AI chat panel each announce exactly once', () => {
  const h = aiChatHarness();
  const inst = h.instance();
  h.api.openChat(inst, h.host);
  h.api.minimizeChat(inst, h.host);
  h.api.openChat(inst, h.host);       // re-open from minimized
  h.api.closeChatAndSave(inst, h.host);

  assert.deepEqual(h.notifications, [
    { chatOpen: true, chatMinimized: false },   // open
    { chatOpen: false, chatMinimized: true },   // minimize
    { chatOpen: true, chatMinimized: false },   // re-open
    { chatOpen: false, chatMinimized: false },  // ✕ close
  ]);
});

test('no-op AI chat transitions stay silent (nothing changed, nothing to repaint)', () => {
  const h = aiChatHarness();
  const closed = h.instance();
  h.api.minimizeChat(closed, h.host);        // already closed
  assert.deepEqual(h.notifications, []);

  const open = h.instance({ chatOpen: true });
  h.api.openChat(open, h.host);             // already open (only re-anchors the DOM)
  assert.deepEqual(h.notifications, []);
});

// ─── JumpServer panel (jumpserver-panel.ts) ──────────────────

function jumpServerHarness() {
  const code = compile(
    ['isJumpServerPanelOpen', 'openJumpServerPanel', 'closeJumpServerPanel', 'destroyJumpServerPanel']
      .map((name) => fnSource('jumpserver-panel.ts', name))
      .join('\n'),
  );

  const notifications: number[] = [];
  const element = () => ({
    style: {} as Record<string, string>,
    innerHTML: '',
    id: '',
    className: '',
    parentElement: null as unknown,
    remove() {},
  });
  const mainContent = {
    offsetWidth: 1200,
    appendChild(child: { parentElement: unknown }) { child.parentElement = mainContent; },
    removeChild: () => {},
  };

  const api = new Function(
    'document', 'localStorage', 'getPanelBounds', 'setupResizeHandle', 'renderPanelContent',
    'stopDocking', 'notifyToolbarPanelState',
    `let panelEl = null, resizeHandleEl = null, currentConfig = null, panelWidth = 320;
     const LS_KEY = 'meterm-js-panel-width';
     ${code}
     return {
       openJumpServerPanel, closeJumpServerPanel, destroyJumpServerPanel, isJumpServerPanelOpen,
       panelOpen: () => isJumpServerPanelOpen(),
     };`,
  )(
    { getElementById: () => mainContent, createElement: () => element() },
    { getItem: () => null, setItem: () => {} },
    () => ({ min: 200, max: 600 }),
    () => {},
    () => {},                                     // renderPanelContent
    () => {},                                     // stopDocking
    () => notifications.push(notifications.length + 1),
  );

  const connection = { name: 'jump-1' };
  return { api, notifications, connection };
}

test('opening and closing the JumpServer panel announces the transition once', () => {
  const h = jumpServerHarness();
  assert.equal(h.api.isJumpServerPanelOpen(), false);

  h.api.openJumpServerPanel(h.connection as never);
  assert.equal(h.api.isJumpServerPanelOpen(), true);
  assert.equal(h.notifications.length, 1, 'opening must repaint the toolbar button');

  h.api.closeJumpServerPanel();
  assert.equal(h.api.isJumpServerPanelOpen(), false);
  assert.equal(h.notifications.length, 2, 'closing must clear the toolbar highlight');
});

test('no-op JumpServer transitions stay silent, and teardown still clears the highlight', () => {
  const h = jumpServerHarness();
  h.api.closeJumpServerPanel();                        // never opened
  assert.deepEqual(h.notifications, []);

  h.api.openJumpServerPanel(h.connection as never);
  h.api.openJumpServerPanel({ name: 'jump-2' } as never); // switching connection: still open
  assert.equal(h.notifications.length, 1);

  h.api.destroyJumpServerPanel();                      // logout / pop-out teardown while open
  assert.equal(h.notifications.length, 2);
  h.api.destroyJumpServerPanel();                      // nothing left to tear down
  assert.equal(h.notifications.length, 2);
});

// ─── Cross-module contract (no imports between the two sides) ──

test('the toolbar reads both panels from a single state source per panel', () => {
  const src = read('toolbar.ts');
  assert.match(src, /toolbar-icon-btn ai-agent-btn\$\{chatOpen \? ' active' : ''\}/);
  assert.match(src, /AICapsuleManager\.isChatSidebarOpen\(agentSessionId\)/);
  assert.match(src, /toolbar-icon-btn\$\{isJumpServerPanelOpen\(\) \? ' active' : ''\}/);
  assert.match(src, /addEventListener\('ai-chat-toggled', \(\) => renderToolbarActions\(\)\)/);
});

test('the AI panel announces through one funnel, the JumpServer panel through the toolbar import', () => {
  // Exactly one dispatch site in the manager: the ops layer announces, so the
  // ✕ / − header buttons (which call the ops functions directly) are covered.
  const manager = read('ai-capsule.ts');
  assert.equal((manager.match(/new CustomEvent\('ai-chat-toggled'\)/g) ?? []).length, 1);
  assert.match(manager, /notifyChatToggled: \(\) => document\.dispatchEvent\(new CustomEvent\('ai-chat-toggled'\)\)/);

  // The ops layer must announce from every real transition.
  const ops = read('ai-capsule-chat-ops.ts');
  assert.equal((ops.match(/host\.notifyChatToggled\(\);/g) ?? []).length, 3);
  assert.match(ops, /notifyChatToggled\(\): void;/);

  const js = read('jumpserver-panel.ts');
  assert.match(js, /import\('\.\/toolbar'\)\s*\.then\(\(\{ renderToolbarActions \}\) => renderToolbarActions\(\)\)/);
  assert.equal((js.match(/notifyToolbarPanelState\(\)/g) ?? []).length, 4); // 1 decl + 3 call sites
});
