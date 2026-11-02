import { writeTextFile, readTextFile, mkdir, exists, readDir, remove, rename, BaseDirectory } from '@tauri-apps/plugin-fs';
import { t, getLanguage } from './i18n';
import { getPopupScrollViewport } from './overlay-scrollbar';
import type { AICapsuleInstance, ConvEntry, ChatConversation } from './ai-capsule-types';
import { hostsMatch, validHost } from './ai-conversation-host';
import { currentConversationHost, conversationHostLabel } from './ai-conversation-host-ui';
import { bindLegacyHistory, deleteHistoryFiles } from './ai-conversation-binding-store';
import { loadSettings } from './themes';
import { showToast } from './notify';
import {
  CHAT_DIR, SUMMARY_DIR, summaryPath, entriesForHistory, buildSummary, parseSummary, conversationsToPrune,
  lastActivity, historyDateGroup, searchKeywords, highlightRuns, searchSnippet,
  type ConversationSummary, type HistoryDateGroup,
} from './ai-chat-history-store';

const FS_OPTS = { baseDir: BaseDirectory.AppData };

let _chatHistoryDirReady = false;

type HistoryListDeps = {
  ensurePopupResizeHandle: (panel: HTMLElement, aiBar: HTMLElement) => void;
  restoreConversation: (inst: AICapsuleInstance, conv: ChatConversation) => void;
  loadConversation: (id: string) => Promise<ChatConversation | null>;
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
  convs: ConversationSummary[];
  deps: HistoryListDeps | null;
  query: string;
}

const HISTORY_SCOPES = ['current', 'all'] as const;
const historyChrome = new WeakMap<HTMLDivElement, HistoryChrome>();
const bindingListenerAttached = new WeakSet<HTMLDivElement>();

/** A cached chrome stays valid only while both halves are still inside the target. */
const attachedTo = (target: HTMLElement, node: HTMLElement): boolean =>
  Array.from(target.children).includes(node);

const RENAME_OPTS = { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData };

/** Summaries handed out by the last listing, so a binding shows without a reload. */
const listedSummaries = new Map<string, ConversationSummary>();

export async function bindLegacyConversation(id: string, host: NonNullable<ChatConversation['hostBinding']>): Promise<void> {
  await bindLegacyHistory(id, host, {
    read: path => readTextFile(path, FS_OPTS),
    write: (path, text) => writeTextFile(path, text, FS_OPTS),
    exists: path => exists(path, FS_OPTS),
    remove: path => remove(path, FS_OPTS),
    rename: (from, to) => rename(from, to, RENAME_OPTS),
  });
  const listed = listedSummaries.get(id);
  if (listed) listed.hostBinding = host;
  const conv = await loadConversation(id);
  if (conv) await writeSummary(buildSummary(conv));
}

export async function ensureChatDir(): Promise<void> {
  if (_chatHistoryDirReady) return;
  if (!(await exists(SUMMARY_DIR, FS_OPTS))) {
    await mkdir(SUMMARY_DIR, { recursive: true, ...FS_OPTS });
  }
  _chatHistoryDirReady = true;
}

/** Write aside and rename over, so a crash mid-write never leaves a truncated file. */
async function writeAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.save.tmp`;
  await writeTextFile(temporary, text, FS_OPTS);
  await rename(temporary, path, RENAME_OPTS);
}

async function writeSummary(summary: ConversationSummary): Promise<void> {
  try {
    await ensureChatDir();
    await writeAtomically(summaryPath(summary.id), JSON.stringify(summary));
  } catch (e) { console.error('[chat-history] summary write failed:', summary.id, e); }
}

/** Per-conversation write chain: saves of one file never overlap or land out of order. */
const saveChains = new Map<string, Promise<void>>();

export function saveConversation(
  instance: AICapsuleInstance,
  snapshot?: { id: string; messages: ConvEntry[]; hostBinding?: ChatConversation['hostBinding'] },
): Promise<void> {
  if (!loadSettings().aiSaveChatHistory) return Promise.resolve();
  const id = snapshot?.id ?? instance.currentConversationId;
  const msgs = snapshot?.messages ?? instance.messages;
  const hostBinding = snapshot ? snapshot.hostBinding : instance.conversationHost;
  if (msgs.length === 0) return Promise.resolve();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return Promise.resolve();
  // Serialize now: `messages` keeps changing while the write waits its turn.
  const firstUser = msgs.find(m => m.type === 'user');
  const conv: ChatConversation = {
    id,
    hostBinding,
    title: firstUser ? firstUser.content.slice(0, 80) : 'Untitled',
    messages: entriesForHistory(msgs),
    createdAt: msgs[0]?.timestamp || Date.now(),
    updatedAt: lastActivity(msgs, Date.now()),
  };
  const text = JSON.stringify(conv);
  const summary = buildSummary(conv);
  const write = async () => {
    try {
      await ensureChatDir();
      await writeAtomically(`${CHAT_DIR}/${id}.json`, text);
      await writeAtomically(summaryPath(id), JSON.stringify(summary));
    } catch (e) {
      console.error('[chat-history] save failed:', e);
    }
  };
  const next = (saveChains.get(id) ?? Promise.resolve()).then(write);
  saveChains.set(id, next);
  void next.then(() => { if (saveChains.get(id) === next) saveChains.delete(id); });
  return next;
}

/** Read one full conversation; null when it is missing or unreadable. */
export async function loadConversation(id: string): Promise<ChatConversation | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  try {
    const raw = JSON.parse(await readTextFile(`${CHAT_DIR}/${id}.json`, FS_OPTS)) as ChatConversation;
    if (!raw || !Array.isArray(raw.messages)) return null;
    raw.id = id;
    raw.hostBinding = validHost(raw.hostBinding);
    // Migrate old format: { role, content } → { type, content }
    if (raw.messages.length && 'role' in raw.messages[0]) {
      raw.messages = (raw.messages as unknown as { role: string; content: string; timestamp: number }[])
        .map(m => ({ type: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content, timestamp: m.timestamp }));
    }
    return raw;
  } catch (e) { console.error('[chat-history] read failed:', id, e); return null; }
}

/**
 * The history list: one small summary per conversation, newest first. A
 * conversation saved before summaries existed is read in full once and gets
 * its summary written then.
 */
export async function loadConversationSummaries(): Promise<ConversationSummary[]> {
  try {
    await ensureChatDir();
    const ids = (await readDir(CHAT_DIR, FS_OPTS))
      .map(entry => entry.name ?? '')
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .filter(id => /^[a-zA-Z0-9_-]+$/.test(id));
    const summaries = await Promise.all(ids.map(async (id): Promise<ConversationSummary | null> => {
      try {
        const listed = parseSummary(await readTextFile(summaryPath(id), FS_OPTS), id);
        if (listed) { listed.hostBinding = validHost(listed.hostBinding); return listed; }
      } catch { /* no summary yet */ }
      const conv = await loadConversation(id);
      if (!conv) return null;
      const built = buildSummary(conv);
      await writeSummary(built);
      return built;
    }));
    const result = summaries.filter((s): s is ConversationSummary => s !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    listedSummaries.clear();
    for (const summary of result) listedSummaries.set(summary.id, summary);
    return result;
  } catch (e) { console.error('[chat-history] load failed:', e); return []; }
}

/**
 * Apply the retention limit: delete the oldest conversations beyond it, never
 * one that `keep` names (open in a tab). Returns the summaries that remain.
 */
export async function pruneConversations(summaries: ConversationSummary[], keep: ReadonlySet<string>): Promise<ConversationSummary[]> {
  const victims = conversationsToPrune(summaries, loadSettings().aiChatHistoryLimit, keep);
  if (victims.length === 0) return summaries;
  for (const id of victims) await deleteConversation(id);
  const gone = new Set(victims);
  return summaries.filter(s => !gone.has(s.id));
}

export async function deleteConversation(id: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return;
  listedSummaries.delete(id);
  try {
    await ensureChatDir();
    // Let a queued save finish first, or it would write the file back.
    await saveChains.get(id);
    await deleteHistoryFiles(id, {
      exists: path => exists(path, FS_OPTS),
      remove: path => remove(path, FS_OPTS),
    });
  } catch (error) { console.error('[chat-history] delete failed:', error); }
}

interface DangerConfirm {
  title: string;
  message: string;
  ok: string;
  /** Label of an optional "don't ask again for a while" box. */
  checkbox?: string;
}

/** Modal confirm in the AI danger style; resolves whether the user agreed and ticked the box. */
function confirmDanger(options: DangerConfirm): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ai-danger-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'ai-danger-dialog';
    dialog.setAttribute('role', 'alertdialog');

    const title = document.createElement('div');
    title.className = 'ai-danger-title';
    title.textContent = options.title;
    const msg = document.createElement('div');
    msg.className = 'ai-danger-msg';
    msg.textContent = options.message;
    dialog.append(title, msg);

    let checkbox: HTMLInputElement | null = null;
    if (options.checkbox) {
      const checkboxRow = document.createElement('label');
      checkboxRow.className = 'ai-delete-checkbox-row';
      checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'ai-delete-checkbox';
      const checkLabel = document.createElement('span');
      checkLabel.textContent = options.checkbox;
      checkboxRow.append(checkbox, checkLabel);
      dialog.append(checkboxRow);
    }

    const actions = document.createElement('div');
    actions.className = 'ai-danger-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ai-danger-btn ai-danger-btn-cancel';
    cancelBtn.textContent = t('aiChatDeleteConfirmCancel');
    const okBtn = document.createElement('button');
    okBtn.className = 'ai-danger-btn ai-danger-btn-run';
    okBtn.textContent = options.ok;
    actions.append(cancelBtn, okBtn);
    dialog.append(actions);

    const close = (ok: boolean) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve({ ok, checked: ok && !!checkbox?.checked });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(false); }
    };
    document.addEventListener('keydown', onKey, true);
    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    cancelBtn.focus();
  });
}

export async function confirmDeleteConversation(
  setDeleteSkipUntil: (ts: number) => void,
): Promise<boolean> {
  const { ok, checked } = await confirmDanger({
    title: t('aiChatDeleteConfirmTitle'),
    message: t('aiChatDeleteConfirmMsg'),
    ok: t('aiChatDeleteConfirmOk'),
    checkbox: t('aiChatDeleteNoAskMinutes'),
  });
  if (checked) setDeleteSkipUntil(Date.now() + 5 * 60 * 1000);
  return ok;
}

/** Ask before opening another conversation stops the task that is running. */
export async function confirmStopRunningTask(): Promise<boolean> {
  const { ok } = await confirmDanger({
    title: t('aiChatSwitchRunningTitle'),
    message: t('aiChatSwitchRunningMsg'),
    ok: t('aiChatSwitchRunningOk'),
  });
  return ok;
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

const GROUP_LABELS = {
  today: 'aiChatGroupToday',
  yesterday: 'aiChatGroupYesterday',
  week: 'aiChatGroupWeek',
  earlier: 'aiChatGroupEarlier',
} as const;

const dateLocale = (): string => (getLanguage() === 'zh' ? 'zh-CN' : 'en-US');

/** The time on a row: the group heading already says which day. */
function formatListTime(timestamp: number, group: HistoryDateGroup): string {
  const date = new Date(timestamp);
  const locale = dateLocale();
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (group === 'today' || group === 'yesterday') return time;
  if (group === 'week') return `${date.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(locale, sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Append `text` to `target` with the search words wrapped in <mark>. */
function appendHighlighted(target: HTMLElement, text: string, keywords: readonly string[]): void {
  for (const run of highlightRuns(text, keywords)) {
    if (run.hit) {
      const mark = document.createElement('mark');
      mark.textContent = run.text;
      target.appendChild(mark);
    } else {
      target.appendChild(document.createTextNode(run.text));
    }
  }
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

  // Every word must match somewhere in the conversation, so "nginx 502" finds
  // a conversation titled "nginx" whose reply mentions 502.
  const keywords = searchKeywords(query);
  const filtered = keywords.length
    ? scoped.filter(c => {
        const haystack = `${c.title}\n${conversationHostLabel(c.hostBinding)}\n${c.searchText}`.toLowerCase();
        return keywords.every(keyword => haystack.includes(keyword));
      })
    : scoped;

  if (filtered.length === 0) {
    rows.className = 'ai-chat-hist-empty';
    rows.textContent = t('aiChatHistoryEmpty');
    return;
  }

  const now = Date.now();
  let group: HistoryDateGroup | null = null;
  for (const conv of filtered) {
    const convGroup = historyDateGroup(conv.updatedAt, now);
    if (convGroup !== group) {
      group = convGroup;
      const heading = document.createElement('div');
      heading.className = 'ai-chat-hist-group';
      heading.textContent = t(GROUP_LABELS[convGroup]);
      rows.appendChild(heading);
    }

    const row = document.createElement('div');
    row.className = 'ai-chat-hist-row';
    row.tabIndex = 0; row.setAttribute('role', 'button');
    if (conv.id === instance.currentConversationId) {
      row.classList.add('current');
      row.setAttribute('aria-current', 'true');
    }
    // The list holds summaries only; the full conversation is read on open.
    let opening = false;
    const open = async () => {
      if (opening) return;
      opening = true;
      try {
        const full = await deps.loadConversation(conv.id);
        if (full) deps.restoreConversation(instance, full);
        else showToast({ title: t('aiChatHistoryTitle'), body: t('aiChatHistoryLoadFailed') });
      } finally { opening = false; }
    };
    row.addEventListener('click', () => { void open(); });
    row.addEventListener('keydown', event => {
      if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); void open();
      }
    });

    const info = document.createElement('div');
    info.className = 'ai-chat-hist-info';

    const rowTitle = document.createElement('div');
    rowTitle.className = 'ai-chat-hist-row-title';
    appendHighlighted(rowTitle, conv.title, keywords);
    info.appendChild(rowTitle);

    // Why it matched, when the title alone does not show it.
    const titleLower = conv.title.toLowerCase();
    const snippet = keywords.some(keyword => !titleLower.includes(keyword))
      ? searchSnippet(conv.searchText, keywords.filter(keyword => !titleLower.includes(keyword)))
      : null;
    if (snippet) {
      const rowSnippet = document.createElement('div');
      rowSnippet.className = 'ai-chat-hist-row-snippet';
      appendHighlighted(rowSnippet, snippet, keywords);
      info.appendChild(rowSnippet);
    }

    const rowMeta = document.createElement('div');
    rowMeta.className = 'ai-chat-hist-row-meta';
    rowMeta.textContent = `${conversationHostLabel(conv.hostBinding)} · ${t('aiChatMessageCount').replace('{n}', String(conv.messageCount))} · ${formatListTime(conv.updatedAt, convGroup)}`;
    rowMeta.title = new Date(conv.updatedAt).toLocaleString(dateLocale());
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
  convs: ConversationSummary[],
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
