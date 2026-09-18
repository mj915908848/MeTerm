import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { hostsMatch, sshConversationHost, validHost } from '../src/ai-conversation-host.ts';
import { bindLegacyHistory } from '../src/ai-conversation-binding-store.ts';

/**
 * Load a source module with an explicit dependency table.
 *
 * Every value import of the module must be listed: an unlisted specifier throws
 * `unexpected dependency <name>` instead of silently resolving to an empty
 * object, so adding an import to the source fails loudly here.
 */
function loadModule(file: string, dependencies: Record<string, any>) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const module = { exports: {} as any };
  new Function('require', 'exports', 'module', js)((name: string) => {
    assert.ok(name in dependencies, `unexpected dependency ${name}`); return dependencies[name];
  }, module.exports, module);
  return module.exports;
}
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const markdown = () => loadModule('ai-capsule-markdown.ts', { './status-bar': { escapeHtml }, './i18n': { t: (key: string) => key } });

test('preview uses opaque RGB theme surface, not bare channel variables', () => {
  const css = readFileSync(new URL('../src/styles/ai-chat.css', import.meta.url), 'utf8');
  const preview = css.match(/\.ai-history-preview\s*\{([^}]+)\}/)![1];
  assert.match(preview, /background:\s*rgb\(var\(--bg-primary/);
  assert.doesNotMatch(preview, /background:\s*var\(--bg-primary/);
  assert.doesNotMatch(css, /\.ai-history-preview-overlay\s*\{/);
  for (const theme of ['themes.css', 'neo-brutalism.css']) {
    const source = readFileSync(new URL(`../src/styles/${theme}`, import.meta.url), 'utf8');
    assert.match(source, /--bg-primary:\s*\d+,\s*\d+,\s*\d+/);
  }
});

test('side history preview stays inline, preserves active task and returns to the same list', () => {
  class Node {
    children: Node[] = []; parentElement: Node | null = null;
    className = ''; attrs: Record<string, string> = {}; scrollTop = 15;
    style = {}; dataset = {}; onclick?: () => void;
    classList = { contains: (name: string) => this.className.includes(name), add: (name: string) => { this.className += ' ' + name; } };
    get childNodes() { return this.children; }
    append(...nodes: Node[]) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes: Node[]) { this.children.forEach(node => { node.parentElement = null; }); this.children = []; this.append(...nodes); }
    setAttribute(key: string, value: string) { this.attrs[key] = value; }
    addEventListener() {} querySelectorAll() { return []; } focus() {}
  }
  let renderedReadonly = false;
  let renderedToolCard = false;
  const mod = loadModule('ai-conversation-host-ui.ts', {
    './drawer': {}, './tabs': {}, './split-pane': {}, './notify': {},
    './ai-capsule-tool-ui': { buildToolCard: () => { renderedToolCard = true; const card = new Node(); card.className = 'ai-tool-card'; return card; } },
    './ai-icons': { thinkingIcon: () => '' },
    './i18n': { t: (key: string) => key },
    './ai-conversation-host': { hostsMatch, sshConversationHost },
    '@tauri-apps/plugin-clipboard-manager': {}, '@tauri-apps/plugin-dialog': {},
    './ai-capsule-markdown': { renderMarkdown: (_: string, __: string, ___: any, options: any) => { renderedReadonly = options.allowRun === false; return 'answer'; } },
  });
  const panel = new Node(); panel.className = 'ai-side-chat-history-view';
  const originalList = new Node(); panel.append(originalList);
  const instance = { chatHistoryPanel: panel, messages: ['current task'], currentConversationId: 'active' };
  (globalThis as any).document = { activeElement: null, createElement: () => new Node(), body: { append: () => assert.fail('modal appended') } };
  try {
    mod.previewHostConversation({ title: 'history', messages: [
      { type: 'user', content: 'question' }, { type: 'thinking', content: '', reasoning: 'reasoning' },
      { type: 'assistant', content: 'answer' }, { type: 'tool_call', toolName: 'run_command', args: {}, result: 'result' },
    ] }, instance);
    const preview = panel.children[0];
    assert.equal(preview.attrs.role, 'region'); assert.equal(preview.attrs['aria-modal'], undefined);
    assert.ok(renderedReadonly); assert.deepEqual(instance.messages, ['current task']);
    const body = preview.children[4];
    assert.match(body.className, /ai-chat-messages/);
    assert.equal(body.children[0].className, 'ai-msg ai-msg-user');
    assert.equal(body.children[1].className, 'ai-thinking-block');
    assert.equal(body.children[2].className, 'ai-msg ai-msg-assistant');
    assert.ok(renderedToolCard);
    assert.equal(instance.currentConversationId, 'active');
    assert.equal(preview.children[0].className, 'ai-history-preview-back');
    assert.equal(preview.children[0].textContent, '← aiChatPreviewBack');
    preview.children[0].onclick!();
    assert.equal(panel.children[0], originalList); assert.equal(panel.scrollTop, 15);
  } finally { delete (globalThis as any).document; }
});

test('cross-host and legacy restore only preview, never clear or overwrite active conversation', () => {
  let previews = 0;
  const ops = loadModule('ai-capsule-chat-ops.ts', {
    './i18n': { t: (key: string) => key }, './themes': { loadSettings: () => ({}) },
    './terminal': { TerminalRegistry: {} }, './overlay-scrollbar': { createOverlayScrollbar: () => {} },
    './ai-capsule-markdown': { renderMarkdown: () => '' }, './ai-provider': { resolveActiveModel: () => ({}) },
    './ai-icons': { thinkingIcon: () => '' }, './ai-capsule-layout': {},
    './ai-capsule-bar-dom': { syncBarPlaceholder: () => {} },
    './ai-capsule-model-ui': { buildModelDropdown: () => {}, updateModelLabel: () => {} },
    './ai-agent-runner': { runAgentWithCallbacks: () => {} },
    './ai-capsule-image-attach': { clearPendingImages: () => {} },
    './ai-capsule-file-attach': { clearPendingAttachments: () => {} },
    './ai-image-lightbox': { attachLightboxClick: () => {} },
    './ai-empty-state': { renderEmptyState: () => {} },
    './ai-capsule-tab-state': { resolveFocusedPaneNumber: () => 1 },
    './ai-conversation-host': { hostsMatch },
    './ai-conversation-host-ui': { currentConversationHost: () => sshConversationHost('a', 22), previewHostConversation: () => previews++, allowConversationSend: () => false },
    './ai-capsule-chat-persistence': { bindLegacyConversation: () => {} },
    './ai-capsule-chat-ui': { attachPersistentTodoListener: () => {} },
    './ai-capsule-tool-ui': { renderTodoBoard: () => {}, restoreTodoBoardFromHistory: () => {} },
  });
  const instance = { currentConversationId: 'active', messages: ['unchanged'], agent: { clear: () => assert.fail('cleared agent') } };
  for (const hostBinding of [undefined, sshConversationHost('b', 22)]) {
    ops.restoreConversation(instance, { id: 'other', hostBinding }, {});
  }
  ops.sendToLLMFrom(instance, 'command', { injectUserMessage: () => assert.fail('injected') });
  assert.equal(previews, 2); assert.equal(instance.currentConversationId, 'active');
  assert.deepEqual(instance.messages, ['unchanged']);
});

// Minimal DOM for the history list: just enough for the controls + rows split.
function historySurface(className: string) {
  class Element {
    children: Element[] = []; className = ''; dataset: Record<string, string> = {}; textContent = ''; value = ''; type = ''; placeholder = ''; onclick?: () => void;
    handlers: Record<string, Function> = {}; attrs: Record<string, string> = {};
    tag: string;
    constructor(tag: string) { this.tag = tag; }
    set innerHTML(_: string) { this.children = []; }
    classList = { contains: (name: string) => this.className === name };
    append(...children: Element[]) { this.children.push(...children); }
    appendChild(child: Element) { this.children.push(child); }
    setAttribute(key: string, value: string) { this.attrs[key] = value; }
    addEventListener(name: string, fn: Function) { this.handlers[name] = fn; }
    removeEventListener(name: string) { delete this.handlers[name]; }
  }
  const persistence = loadModule('ai-capsule-chat-persistence.ts', {
    '@tauri-apps/plugin-fs': { BaseDirectory: { AppData: 1 } },
    './i18n': { t: (key: string) => key },
    './ai-icons': {}, './ai-capsule-markdown': {}, './ai-capsule-tool-ui': {},
    './ai-capsule-history': { fuzzyMatch: (text: string, query: string) => text.includes(query), formatRelativeTime: () => 'now' },
    './ai-conversation-host': { hostsMatch, validHost },
    './ai-conversation-host-ui': { currentConversationHost: () => sshConversationHost('a', 22), conversationHostLabel: (host: any) => host?.displayName ?? 'Unbound' },
    './ai-conversation-binding-store': {},
    './overlay-scrollbar': { getPopupScrollViewport: (panel: any) => panel },
  });
  (globalThis as any).document = { createElement: (tag: string) => new Element(tag) };
  const panel = new Element('div'); panel.className = className;
  const instance = { chatHistoryPanel: panel, element: {} };
  const deps = { ensurePopupResizeHandle: () => {}, restoreConversation: () => {}, handleDeleteConversation: () => {} };
  const convs = [sshConversationHost('a', 22), sshConversationHost('b', 22), undefined]
    .map((hostBinding, i) => ({ id: String(i), title: 'goal', hostBinding, messages: [], updatedAt: 1 }));
  return { persistence, panel, instance, deps, convs, dispose: () => { delete (globalThis as any).document; } };
}

test('both history surfaces retain query on scope switch and support empty scoped lists', () => {
  for (const className of ['ai-side-chat-history-view', 'ai-bar-chat-history-panel']) {
    const surface = historySurface(className);
    try {
      const { persistence, panel, instance, deps, convs } = surface;
      persistence.renderChatHistoryListFromCache(instance, convs, deps, 'goal');
      assert.equal(panel.children[1].children.length, 1);
      panel.children[0].children[1].onclick!();
      assert.equal(panel.children[1].children.length, 3);
      persistence.renderChatHistoryListFromCache(instance, convs.slice(1), deps, 'goal');
      assert.equal(panel.children[1].children.length, 2); // deletion refresh retains all scope
      panel.children[0].children[0].onclick!();
      assert.equal(panel.children[1].className, 'ai-chat-hist-empty');
    } finally { surface.dispose(); }
  }
});

test('side history keeps one stable search field so IME composition survives typing', () => {
  const surface = historySurface('ai-side-chat-history-view');
  try {
    const { persistence, panel, instance, deps, convs } = surface;
    persistence.renderChatHistoryListFromCache(instance, convs, deps);
    const controls = panel.children[0];
    const rows = panel.children[1];
    const field = panel.children[0].children[2];
    assert.equal(field.type, 'search');
    // Each keystroke re-renders the rows only; destroying the focused field instead
    // would abort an in-flight composition and drop the composed characters.
    for (const value of ['g', 'go', 'goal']) {
      field.value = value;
      field.handlers.input();
      assert.equal(panel.children[0], controls);
      assert.equal(panel.children[1], rows);
      assert.equal(panel.children[0].children[2], field);
    }
    assert.equal(field.value, 'goal');
    assert.equal(panel.children[1].children.length, 1);
    // Switching scope keeps the typed query rather than a stale render closure.
    panel.children[0].children[1].onclick!();
    assert.equal(panel.children[1].children.length, 3);
    assert.equal(panel.children[0].children[2].value, 'goal');
    assert.equal(panel.children[0].children[2], field);
  } finally { surface.dispose(); }
});

test('AI Bar popup keeps a single search entry by reusing the AI Bar input', () => {
  const surface = historySurface('ai-bar-chat-history-panel');
  try {
    const { persistence, panel, instance, deps, convs } = surface;
    persistence.renderChatHistoryListFromCache(instance, convs, deps, 'goal');
    const controls = panel.children[0];
    assert.equal(controls.children.length, 2); // scope buttons only — no second search field
    assert.equal(panel.dataset.historyQuery, 'goal');
    assert.equal(panel.children[1].children.length, 1);
    // The AI Bar input filters through renderListFromCache; the panel only re-renders.
    panel.dataset.historyScope = 'all';
    persistence.renderChatHistoryListFromCache(instance, convs, deps, 'goal');
    assert.equal(panel.children[1].children.length, 3);
    assert.equal(panel.children[0], controls);
    assert.equal(panel.children[0].children.length, 2);
  } finally { surface.dispose(); }
});

test('identity is normalized address plus port, without username or DNS equivalence', () => {
  assert.deepEqual(sshConversationHost(' HOST.Example ', 22), { kind: 'ssh', address: 'host.example', port: 22, displayName: 'host.example:22' });
  assert.ok(hostsMatch(sshConversationHost('HOST', 22), sshConversationHost('host', 22)));
  assert.equal(hostsMatch(sshConversationHost('host', 22), sshConversationHost('host', 2222)), false);
  assert.equal(hostsMatch(sshConversationHost('localhost', 22), sshConversationHost('127.0.0.1', 22)), false);
  assert.ok(hostsMatch({ kind: 'local' }, { kind: 'local' }));
  assert.equal(hostsMatch(undefined, { kind: 'local' }), false);
});
test('legacy and malformed bindings are unbound; deserialization excludes credentials', () => {
  for (const raw of [undefined, null, {}, { kind: 'ssh', address: 'h', port: 0 }, { kind: 'ssh', address: 'h', port: '22' }]) assert.equal(validHost(raw), undefined);
  const host = validHost({ kind: 'ssh', address: ' h ', port: 22, username: 'root', password: 'secret', displayName: '<script>' })!;
  assert.equal(JSON.stringify(host).includes('secret'), false);
  assert.equal(JSON.stringify(host).includes('username'), false);
  assert.equal((host as any).displayName, 'h:22');
});
test('readonly markdown keeps copy but cannot produce executable command buttons', () => {
  const renderer = markdown();
  const text = '```bash\nrm example\n```';
  const normal = renderer.renderMarkdown(text, 'session', () => {});
  const readonly = renderer.renderMarkdown(text, '', () => {}, { allowRun: false });
  assert.match(normal, /ai-cmd-run/);
  assert.doesNotMatch(readonly, /ai-cmd-run|data-session=/);
  assert.match(readonly, /ai-cmd-copy/); assert.match(readonly, /ai-response-copy/);
});
test('focused pane determines host and different username does not affect identity', () => {
  let focusedPaneId = 'b';
  let warnings = 0;
  const mod = loadModule('ai-conversation-host-ui.ts', {
    './drawer': { DrawerManager: { getServerInfo: (id: string) => id === 'ssh' ? { host: 'Host', port: 22, username: 'root' } : null } },
    './tabs': { TabManager: { locateSession: () => ({ tab: { get focusedPaneId() { return focusedPaneId; }, splitRoot: {} } }) } },
    './split-pane': { getAllLeaves: () => [{ id: 'a', sessionId: 'local' }, { id: 'b', sessionId: 'ssh' }] },
    './i18n': { t: (key: string) => key },
    './notify': { showToast: () => warnings++ },
    './ai-conversation-host': { hostsMatch, sshConversationHost },
    '@tauri-apps/plugin-clipboard-manager': {}, './ai-capsule-markdown': {}, '@tauri-apps/plugin-dialog': {}, './ai-capsule-tool-ui': {}, './ai-icons': {},
  });
  const instance = { sessionId: 'local', conversationHost: sshConversationHost('host', 22) };
  assert.ok(hostsMatch(mod.currentConversationHost(instance), instance.conversationHost));
  assert.equal(mod.allowConversationSend(instance), true);
  focusedPaneId = 'a';
  // Blocked send surfaces an in-app toast instead of blocking the webview.
  assert.equal(mod.allowConversationSend(instance), false);
  assert.equal(warnings, 1);
});
test('save captures binding before async IO and explicit snapshots never borrow current host', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: any[] = [];
  const persistence = loadModule('ai-capsule-chat-persistence.ts', {
    '@tauri-apps/plugin-fs': { BaseDirectory: { AppData: 1 }, exists: async () => { await gate; return true; }, writeTextFile: async (_: string, text: string) => writes.push(JSON.parse(text)) },
    './i18n': {}, './ai-icons': {}, './ai-capsule-markdown': {}, './ai-capsule-history': {}, './ai-capsule-tool-ui': {}, './overlay-scrollbar': {},
    './ai-conversation-host': { hostsMatch, validHost }, './ai-conversation-host-ui': {},
    './ai-conversation-binding-store': {},
  });
  const original = sshConversationHost('a', 22);
  const instance = { currentConversationId: 'old', conversationHost: original, messages: [{ type: 'user', content: 'goal', timestamp: 1 }] };
  const pending = persistence.saveConversation(instance);
  instance.conversationHost = sshConversationHost('b', 22); instance.currentConversationId = 'new';
  release(); await pending;
  assert.equal(writes[0].id, 'old'); assert.deepEqual(writes[0].hostBinding, original);
  await persistence.saveConversation(instance, { id: 'legacy', messages: instance.messages });
  assert.equal(writes[1].hostBinding, undefined);
});

test('explicit legacy binding preserves original transcript, unknown fields and backup', async () => {
  const original = JSON.stringify({ id: 'legacy', title: 'old', messages: [{ role: 'user', content: 'limit' }], createdAt: 1, updatedAt: 2, extra: 'preserved' });
  const files = new Map([['chat-history/legacy.json', original]]);
  const storage = {
    read: async (path: string) => files.get(path)!,
    write: async (path: string, value: string) => { files.set(path, value); },
    exists: async (path: string) => files.has(path),
    rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
    remove: async (path: string) => { files.delete(path); },
  };
  await bindLegacyHistory('legacy', sshConversationHost(' HOST ', 2222), storage);
  const saved = JSON.parse(files.get('chat-history/legacy.json')!);
  assert.deepEqual(saved, { ...JSON.parse(original), hostBinding: sshConversationHost('host', 2222) });
  assert.equal(files.get('chat-history/legacy.json.pre-host-binding.bak'), original);
  await assert.rejects(bindLegacyHistory('legacy', { kind: 'local' }, storage), /already bound/);
  await assert.rejects(bindLegacyHistory('../legacy', { kind: 'local' }, storage), /Invalid/);
});

test('failed replacement leaves legacy history unchanged and permits retry', async () => {
  const original = JSON.stringify({ id: 'retry', messages: [] });
  const files = new Map([['chat-history/retry.json', original]]);
  let fail = true;
  const storage = {
    read: async (path: string) => files.get(path)!,
    write: async (path: string, value: string) => { files.set(path, value); },
    exists: async (path: string) => files.has(path),
    rename: async (from: string, to: string) => { if (fail) throw new Error('disk error'); files.set(to, files.get(from)!); files.delete(from); },
    remove: async (path: string) => { files.delete(path); },
  };
  await assert.rejects(bindLegacyHistory('retry', { kind: 'local' }, storage), /disk error/);
  assert.equal(files.get('chat-history/retry.json'), original);
  assert.equal(files.has('chat-history/retry.json.binding.tmp'), false);
  fail = false;
  await bindLegacyHistory('retry', { kind: 'local' }, storage);
  assert.equal(files.get('chat-history/retry.json.pre-host-binding.bak'), original);
  assert.deepEqual(JSON.parse(files.get('chat-history/retry.json')!).hostBinding, { kind: 'local' });
});

test('legacy preview requires confirmation and freezes target before asynchronous confirmation', async () => {
  class Element {
    children: Element[] = []; parentElement: Element | null = null; className = ''; textContent = ''; disabled = false;
    style = {}; scrollTop = 0; isConnected = true; onclick?: () => Promise<void>;
    classList = { contains: (value: string) => this.className.includes(value), add: () => {} };
    get childNodes() { return this.children; }
    append(...nodes: Element[]) { nodes.forEach(node => { node.parentElement = this; this.children.push(node); }); }
    replaceChildren(...nodes: Element[]) { this.children = []; this.append(...nodes); }
    remove() { this.parentElement!.children = this.parentElement!.children.filter(node => node !== this); }
    setAttribute() {} addEventListener() {} querySelectorAll() { return []; } focus() {}
  }
  let address = 'first'; let accepted = false; const targets: any[] = [];
  const mod = loadModule('ai-conversation-host-ui.ts', {
    './split-pane': {}, './notify': {}, '@tauri-apps/plugin-clipboard-manager': {}, './ai-capsule-markdown': {}, './ai-capsule-tool-ui': {}, './ai-icons': {},
    // Keeps the {host} placeholder so the test can assert the frozen target below.
    './i18n': { t: (key: string) => key === 'aiChatBindConfirmBody' ? 'Bind {host}?' : key },
    './ai-conversation-host': { hostsMatch, sshConversationHost },
    './tabs': { TabManager: { locateSession: () => null } },
    './drawer': { DrawerManager: { getServerInfo: () => ({ host: address, port: 2222 }) } },
    '@tauri-apps/plugin-dialog': { confirm: async (message: string) => { assert.match(message, /first:2222/); address = 'second'; return accepted; } },
  });
  (globalThis as any).document = { activeElement: null, createElement: () => new Element() };
  try {
    const panel = new Element(); panel.className = 'ai-side-chat-history-view';
    const instance = { sessionId: 'local', chatHistoryPanel: panel, currentConversationId: 'active' };
    mod.previewHostConversation({ title: 'legacy', messages: [] }, instance, async (target: any) => { targets.push(target); });
    const button = panel.children[0].children[4];
    await button.onclick!(); assert.equal(targets.length, 0); assert.equal(button.disabled, false);
    address = 'first'; accepted = true;
    await button.onclick!();
    assert.deepEqual(targets, [sshConversationHost('first', 2222)]);
    assert.equal(instance.currentConversationId, 'active');
  } finally { delete (globalThis as any).document; }
});
