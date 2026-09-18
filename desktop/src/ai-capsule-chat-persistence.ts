import { writeTextFile, readTextFile, mkdir, exists, readDir, remove, rename, BaseDirectory } from '@tauri-apps/plugin-fs';
import { t } from './i18n';
import { thinkingIcon } from './ai-icons';
import { renderMarkdown } from './ai-capsule-markdown';
import { fuzzyMatch, formatRelativeTime } from './ai-capsule-history';
import { buildToolCard } from './ai-capsule-tool-ui';
import { createOverlayScrollbar, getPopupScrollViewport } from './overlay-scrollbar';
import type { AICapsuleInstance, ConvEntry, ChatConversation } from './ai-capsule-types';
import { hostsMatch, validHost } from './ai-conversation-host';
import { currentConversationHost, conversationHostLabel } from './ai-conversation-host-ui';
import { bindLegacyHistory, deleteHistoryFiles } from './ai-conversation-binding-store';

const CHAT_DIR = 'chat-history';
const FS_OPTS = { baseDir: BaseDirectory.AppData };

let _chatHistoryDirReady = false;

type HistoryListDeps = {
  ensurePopupResizeHandle: (panel: HTMLElement, aiBar: HTMLElement) => void;
  restoreConversation: (inst: AICapsuleInstance, conv: ChatConversation) => void;
  handleDeleteConversation: (inst: AICapsuleInstance, convId: string) => void;
};

/**
 * Controls and rows are split so that a keystroke only re-renders the rows.
 *
 * Rebuilding the whole panel on every `input` event destroyed the focused search
 * field: IME composition still fires `input` while `isComposing` is true, and
 * removing the focused element mid-composition aborts it and drops the
 * characters a Chinese/Japanese user is still typing. The chrome is therefore
 * built once per panel and reused until something else clears the panel.
 */
interface HistoryChrome {
  controls: HTMLDivElement;
  scopeButtons: HTMLButtonElement[];
  /** `null` when the host input field already filters the list (AI Bar popup). */
  search: HTMLInputElement | null;
  rows: HTMLDivElement;
  /** Latest render inputs, so reused controls never act on a stale list. */
  convs: ChatConversation[];
  deps: HistoryListDeps | null;
  query: string;
}

const HISTORY_SCOPES = ['current', 'all'] as const;
const historyChrome = new WeakMap<HTMLDivElement, HistoryChrome>();
const bindingListenerAttached = new WeakSet<HTMLDivElement>();

/** A cached chrome stays valid only while both halves are still inside the target. */
const attachedTo = (target: HTMLElement, node: HTMLElement): boolean =>
  Array.from(target.children).includes(node);

export async function bindLegacyConversation(id: string, host: NonNullable<ChatConversation['hostBinding']>): Promise<void> {
  await bindLegacyHistory(id, host, {
    read: path => readTextFile(path, FS_OPTS),
    write: (path, text) => writeTextFile(path, text, FS_OPTS),
    exists: path => exists(path, FS_OPTS),
    remove: path => remove(path, FS_OPTS),
    rename: (from, to) => rename(from, to, { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData }),
  });
}

export async function ensureChatDir(): Promise<void> {
  if (_chatHistoryDirReady) return;
  if (!(await exists(CHAT_DIR, FS_OPTS))) {
    await mkdir(CHAT_DIR, { recursive: true, ...FS_OPTS });
  }
  _chatHistoryDirReady = true;
}

export async function saveConversation(
  instance: AICapsuleInstance,
  snapshot?: { id: string; messages: ConvEntry[]; hostBinding?: ChatConversation['hostBinding'] },
): Promise<void> {
  const id = snapshot?.id ?? instance.currentConversationId;
  const msgs = snapshot?.messages ?? instance.messages;
  const hostBinding = snapshot ? snapshot.hostBinding : instance.conversationHost;
  if (msgs.length === 0) return;
  try {
    await ensureChatDir();
    const firstUser = msgs.find(m => m.type === 'user');
    const conv: ChatConversation = {
      id,
      hostBinding,
      title: firstUser ? firstUser.content.slice(0, 80) : 'Untitled',
      messages: msgs,
      createdAt: msgs[0]?.timestamp || Date.now(),
      updatedAt: Date.now(),
    };
    const safeId = conv.id.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return;
    const filePath = `${CHAT_DIR}/${safeId}.json`;
    await writeTextFile(filePath, JSON.stringify(conv), FS_OPTS);
  } catch (e) {
    console.error('[chat-history] save failed:', e);
  }
}

export async function loadConversations(): Promise<ChatConversation[]> {
  try {
    await ensureChatDir();
    const entries = await readDir(CHAT_DIR, FS_OPTS);
    const convs: ChatConversation[] = [];
    for (const entry of entries) {
      if (!entry.name?.endsWith('.json')) continue;
      if (/[/\\]/.test(entry.name)) continue;
      try {
        const content = await readTextFile(`${CHAT_DIR}/${entry.name}`, FS_OPTS);
        const raw = JSON.parse(content) as ChatConversation;
        raw.hostBinding = validHost(raw.hostBinding);
        // Migrate old format: { role, content } → { type, content }
        if (raw.messages?.length && 'role' in raw.messages[0]) {
          raw.messages = (raw.messages as unknown as { role: string; content: string; timestamp: number }[])
            .map(m => ({ type: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content, timestamp: m.timestamp }));
        }
        convs.push(raw);
      } catch (e) { console.error('[chat-history] read failed:', entry.name, e); }
    }
    convs.sort((a, b) => b.updatedAt - a.updatedAt);
    return convs;
  } catch (e) { console.error('[chat-history] load failed:', e); return []; }
}

export async function deleteConversation(id: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return;
  try {
    await ensureChatDir();
    await deleteHistoryFiles(id, {
      exists: path => exists(path, FS_OPTS),
      remove: path => remove(path, FS_OPTS),
    });
  } catch (error) { console.error('[chat-history] delete failed:', error); }
}

export function confirmDeleteConversation(
  setDeleteSkipUntil: (ts: number) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ai-danger-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'ai-danger-dialog';

    const title = document.createElement('div');
    title.className = 'ai-danger-title';
    title.textContent = t('aiChatDeleteConfirmTitle');

    const msg = document.createElement('div');
    msg.className = 'ai-danger-msg';
    msg.textContent = t('aiChatDeleteConfirmMsg');

    const checkboxRow = document.createElement('label');
    checkboxRow.className = 'ai-delete-checkbox-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'ai-delete-checkbox';
    const checkLabel = document.createElement('span');
    checkLabel.textContent = t('aiChatDeleteNoAskMinutes');
    checkboxRow.appendChild(checkbox);
    checkboxRow.appendChild(checkLabel);

    const actions = document.createElement('div');
    actions.className = 'ai-danger-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ai-danger-btn ai-danger-btn-cancel';
    cancelBtn.textContent = t('aiChatDeleteConfirmCancel');

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'ai-danger-btn ai-danger-btn-run';
    deleteBtn.textContent = t('aiChatDeleteConfirmOk');

    const close = (result: boolean) => {
      if (result && checkbox.checked) {
        setDeleteSkipUntil(Date.now() + 5 * 60 * 1000);
      }
      overlay.remove();
      resolve(result);
    };

    cancelBtn.addEventListener('click', () => close(false));
    deleteBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

    actions.appendChild(cancelBtn);
    actions.appendChild(deleteBtn);
    dialog.appendChild(title);
    dialog.appendChild(msg);
    dialog.appendChild(checkboxRow);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    cancelBtn.focus();
  });
}

/**
 * Build the controls + rows pair once, then reuse it until something else clears
 * the panel (`renderChatHistoryList` loading state, the detail view, a reopened
 * popup). The rows element doubles as the empty-state placeholder so the panel
 * keeps its original two-child shape.
 */
function ensureHistoryChrome(
  instance: AICapsuleInstance,
  panel: HTMLDivElement,
  target: HTMLElement,
  withSearchField: boolean,
): HistoryChrome {
  const existing = historyChrome.get(panel);
  if (existing && attachedTo(target, existing.controls) && attachedTo(target, existing.rows)) return existing;

  target.innerHTML = '';
  const controls = document.createElement('div'); controls.className = 'ai-history-scope';
  const scopeButtons = HISTORY_SCOPES.map(() => {
    const button = document.createElement('button'); button.type = 'button';
    controls.append(button);
    return button;
  });
  // The AI Bar popup already filters through the AI Bar input (`enterSearchMode`),
  // so it must not grow a second search entry inside the panel.
  let search: HTMLInputElement | null = null;
  if (withSearchField) {
    search = document.createElement('input'); search.type = 'search';
    search.placeholder = t('aiChatHistorySearchPlaceholder');
    search.setAttribute('aria-label', search.placeholder);
    controls.append(search);
  }
  const rows = document.createElement('div'); rows.className = 'ai-chat-hist-list';
  target.append(controls, rows);

  const chrome: HistoryChrome = { controls, scopeButtons, search, rows, convs: [], deps: null, query: '' };
  historyChrome.set(panel, chrome);

  scopeButtons.forEach((button, index) => {
    button.onclick = () => {
      panel.dataset.historyScope = HISTORY_SCOPES[index];
      renderHistoryRows(instance, panel, chrome, chrome.deps);
    };
  });
  if (search) {
    const field = search;
    field.addEventListener('input', () => {
      chrome.query = field.value;
      renderHistoryRows(instance, panel, chrome, chrome.deps);
    });
  }
  // One listener per panel: an explicit legacy binding re-renders from the latest
  // render inputs instead of the closure captured when it was attached.
  if (!bindingListenerAttached.has(panel)) {
    bindingListenerAttached.add(panel);
    panel.addEventListener('ai-history-bound', () => {
      const current = historyChrome.get(panel);
      if (current) renderHistoryRows(instance, panel, current, current.deps);
    });
  }
  return chrome;
}

function renderHistoryRows(
  instance: AICapsuleInstance,
  panel: HTMLDivElement,
  chrome: HistoryChrome,
  deps: HistoryListDeps | null,
): void {
  if (!deps) return;
  const scope = panel.dataset.historyScope ?? 'current';
  const query = chrome.query;
  panel.dataset.historyQuery = query;

  HISTORY_SCOPES.forEach((value, index) => {
    const button = chrome.scopeButtons[index];
    button.textContent = value === 'current' ? t('aiChatScopeCurrent') : t('aiChatScopeAll');
    button.setAttribute('aria-pressed', String(scope === value));
  });
  if (chrome.search && chrome.search.value !== query) chrome.search.value = query;

  const rows = chrome.rows;
  rows.innerHTML = '';
  rows.className = 'ai-chat-hist-list';

  const host = currentConversationHost(instance);
  const scoped = scope === 'all' ? chrome.convs : chrome.convs.filter(conv => hostsMatch(conv.hostBinding, host));

  const filtered = query
    ? scoped.filter(c => fuzzyMatch(c.title, query) || fuzzyMatch(conversationHostLabel(c.hostBinding), query) ||
        c.messages.some(m => m.type !== 'tool_call' && fuzzyMatch(m.content, query)))
    : scoped;

  if (filtered.length === 0) {
    rows.className = 'ai-chat-hist-empty';
    rows.textContent = t('aiChatHistoryEmpty');
    return;
  }

  for (const conv of filtered) {
    const row = document.createElement('div');
    row.className = 'ai-chat-hist-row';
    row.tabIndex = 0; row.setAttribute('role', 'button');
    row.addEventListener('click', () => deps.restoreConversation(instance, conv));
    row.addEventListener('keydown', event => {
      if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); deps.restoreConversation(instance, conv);
      }
    });

    const info = document.createElement('div');
    info.className = 'ai-chat-hist-info';

    const rowTitle = document.createElement('div');
    rowTitle.className = 'ai-chat-hist-row-title';
    rowTitle.textContent = conv.title;

    const rowMeta = document.createElement('div');
    rowMeta.className = 'ai-chat-hist-row-meta';
    rowMeta.textContent = `${conversationHostLabel(conv.hostBinding)} · ${conv.messages.length} msgs · ${formatRelativeTime(conv.updatedAt)}`;

    info.appendChild(rowTitle);
    info.appendChild(rowMeta);

    const delBtn = document.createElement('button');
    delBtn.className = 'ai-chat-hist-delete';
    delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;
    delBtn.title = t('aiChatDeleteConfirmOk');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deps.handleDeleteConversation(instance, conv.id);
    });

    row.appendChild(info);
    row.appendChild(delBtn);
    rows.appendChild(row);
  }
}

export function renderChatHistoryListFromCache(
  instance: AICapsuleInstance,
  convs: ChatConversation[],
  deps: HistoryListDeps,
  filter?: string,
): void {
  const panel = instance.chatHistoryPanel
    || instance.element.querySelector('.ai-bar-chat-history-panel') as HTMLDivElement;
  if (!panel) return;

  // For AI Bar popups, use scroll viewport; for side panel inline view, render directly
  const isSideInline = panel.classList.contains('ai-side-chat-history-view');
  const target = isSideInline ? panel : getPopupScrollViewport(panel);
  const chrome = ensureHistoryChrome(instance, panel, target, isSideInline);
  // The popup resize handle lives in the panel and must be recreated after the
  // panel was cleared, so it is ensured after the chrome — never before.
  deps.ensurePopupResizeHandle(panel, instance.element);

  chrome.convs = convs;
  chrome.deps = deps;
  chrome.query = filter ?? '';
  renderHistoryRows(instance, panel, chrome, deps);
}

export function renderChatHistoryDetail(
  instance: AICapsuleInstance,
  conv: ChatConversation,
  deps: {
    ensurePopupResizeHandle: (panel: HTMLElement, aiBar: HTMLElement) => void;
    renderChatHistoryList: (inst: AICapsuleInstance) => void;
    addHistory: (inst: AICapsuleInstance, cmd: string, source: 'manual' | 'ai') => void;
    bindCommandButtons: (inst: AICapsuleInstance, container: Element) => void;
  },
): void {
  const panel = instance.chatHistoryPanel
    || instance.element.querySelector('.ai-bar-chat-history-panel') as HTMLDivElement;
  if (!panel) return;

  const isSideInline = panel.classList.contains('ai-side-chat-history-view');
  const target = isSideInline ? panel : getPopupScrollViewport(panel);
  target.innerHTML = '';
  deps.ensurePopupResizeHandle(panel, instance.element);

  const header = document.createElement('div');
  header.className = 'ai-chat-hist-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'ai-chat-hist-back';
  backBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="10 3 5 8 10 13"/></svg>`;
  backBtn.title = t('aiChatHistoryBack');
  backBtn.addEventListener('click', () => deps.renderChatHistoryList(instance));

  const title = document.createElement('span');
  title.className = 'ai-chat-hist-title';
  title.textContent = conv.title;

  header.appendChild(backBtn);
  header.appendChild(title);
  target.appendChild(header);

  const msgContainer = document.createElement('div');
  msgContainer.className = 'ai-chat-hist-messages';
  createOverlayScrollbar({ viewport: msgContainer, container: msgContainer });

  for (const msg of conv.messages) {
    const msgEl = document.createElement('div');
    const content = document.createElement('div');
    content.className = 'ai-msg-content';

    if (msg.type === 'tool_call') {
      msgContainer.appendChild(buildToolCard(msg));
      continue;
    } else if (msg.type === 'assistant') {
      msgEl.className = 'ai-msg ai-msg-assistant';
      const addHistoryCb = (cmd: string) => deps.addHistory(instance, cmd, 'ai');
      content.innerHTML = renderMarkdown(msg.content, instance.sessionId, addHistoryCb);
    } else if (msg.type === 'thinking') {
      // Reasoning — standalone block (no bubble).
      // Strip stray think/tool-XML fragments that older sessions might have
      // persisted before we started sanitizing on finalize.
      const cleanedReasoning = msg.reasoning
        ? msg.reasoning
            .replace(/<\/?think(?:ing)?>/gi, '')
            .replace(/<\/(?:arg_value|tool_call|args|tool_use)>/gi, '')
        : '';
      if (cleanedReasoning) {
        const block = document.createElement('div');
        block.className = 'ai-thinking-block';
        const details = document.createElement('details');
        details.className = 'ai-reasoning';
        const summary = document.createElement('summary');
        summary.innerHTML = `${thinkingIcon(12)} <span>${t('aiThinking')}</span>`;
        const textEl = document.createElement('div');
        textEl.className = 'ai-reasoning-text';
        textEl.textContent = cleanedReasoning;
        details.appendChild(summary);
        details.appendChild(textEl);
        block.appendChild(details);
        msgContainer.appendChild(block);
      }
      // Assistant text — render as regular bubble
      if (msg.content) {
        msgEl.className = 'ai-msg ai-msg-assistant';
        const addHistoryCb = (cmd: string) => deps.addHistory(instance, cmd, 'ai');
        content.innerHTML = renderMarkdown(msg.content, instance.sessionId, addHistoryCb);
      } else {
        continue; // No content to render as a bubble
      }
    } else if (msg.type === 'system') {
      msgEl.className = 'ai-msg ai-msg-system';
      content.textContent = msg.content;
    } else {
      // user
      msgEl.className = 'ai-msg ai-msg-user';
      content.textContent = msg.content;
    }

    msgEl.appendChild(content);
    msgContainer.appendChild(msgEl);
  }

  target.appendChild(msgContainer);

  // Bind command buttons in rendered markdown
  deps.bindCommandButtons(instance, msgContainer);
}
