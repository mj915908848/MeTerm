/**
 * file-editor.ts — Tabbed editor window content.
 * Each tab has its own EditorView + wrapper div. Switching tabs shows/hides wrappers.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emitTo, listen } from '@tauri-apps/api/event';
import { revealAfterPaint } from './window-utils';
import { confirm } from '@tauri-apps/plugin-dialog';
import { loadSettings, resolveIsDark } from './themes';
import { t } from './i18n';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { createOverlayScrollbar } from './overlay-scrollbar';
import { planTabWidths } from './tab-layout';
import { renderMarkdown, isImageFile } from './file-editor-md';
import {
  getEditorLanguage as getLang,
  getEditorLanguageExtension as getLangExt,
} from './file-editor-language';
import {
  EDITOR_CONTENT_EVENT,
  EDITOR_DISCONNECTED_EVENT,
  EDITOR_OPEN_EVENT,
  EDITOR_PING_EVENT,
  EDITOR_PONG_EVENT,
  EDITOR_SAVE_REQUEST_EVENT,
  EDITOR_SAVE_RESULT_EVENT,
  EDITOR_TAB_CLOSED_EVENT,
  EDITOR_WINDOW_CLOSED_EVENT,
  EDITOR_MAIN_CLOSE_REQUEST_EVENT,
  EDITOR_MAIN_CLOSE_RESULT_EVENT,
  MAX_EDITOR_FILE_BYTES,
  editorTextFitsLimit,
  isSafeEditorWindowLabel,
  isValidEditorNonce,
  purgeLegacyEditorStorage,
  type EditorContent,
  type EditorDisconnected,
  type EditorOpen,
  type EditorPing,
  type EditorSaveRequest,
  type EditorSaveResult,
  type EditorTabClosed,
  type EditorMainCloseRequest,
  type EditorMainCloseResult,
} from './file-editor-events';
import {
  readText as clipboardReadText,
  writeText as clipboardWriteText,
} from '@tauri-apps/plugin-clipboard-manager';
import {
  buildEditorMenu,
  buildEditorTabMenu,
  detectMacPlatform,
  type EditorMenuCommand,
} from './editor-menu-model';
import { showEditorContextMenu } from './editor-context-menu';

interface TabInfo {
  tabId: string;
  ownerLabel: string;
  sessionId: string;
  filePath: string;
  fileName: string;
  host: string;
  editorView: EditorView | null;
  wrapperEl: HTMLDivElement;
  isDirty: boolean;
  isSaving: boolean;
  content: string;
  loaded: boolean;
  forcedLang: string; // user-selected language override (empty = auto-detect)
  isImage: boolean;   // true if this tab is an image (binary preview)
  mimeType: string;   // MIME type for images
  previewOpen: boolean; // MD preview panel open state
  wrapLines: boolean;   // soft line wrap toggle (default off)
  wrapCompartment: Compartment; // compartment for dynamic wrap reconfigure
}

function resolveThemeAttr(colorScheme: string): string {
  if (colorScheme === 'darker') return 'darker';
  if (colorScheme === 'navy') return 'navy';
  if (colorScheme === 'light') return 'light';
  if (colorScheme === 'neo-brutalism') return 'neo-brutalism';
  if (colorScheme === 'neo-brutalism-rounded') return 'neo-brutalism-rounded';
  if (colorScheme === 'auto') return resolveIsDark('auto') ? 'dark' : 'light';
  return 'dark';
}

const tabs: Map<string, TabInfo> = new Map();
let activeTabId: string | null = null;
let isDark = true;

let tabBarEl: HTMLElement = null!;
let contentEl: HTMLElement = null!;
let statusBarEl: HTMLElement = null!;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===================== 格式化 =====================

/** 支持格式化的语言 ID 集合 */
const FORMATTABLE_LANGS = new Set(['json', 'jsonc', 'xml', 'svg', 'html', 'htm', 'css']);

/** 获取当前 tab 的语言 ID */
function getTabLang(tab: TabInfo): string {
  return tab.forcedLang || getLang(tab.fileName, tab.editorView?.state.doc.toString() || tab.content);
}

/** 判断当前 tab 是否支持格式化 */
function canFormat(tab: TabInfo): boolean {
  return FORMATTABLE_LANGS.has(getTabLang(tab));
}

/** 格式化文本内容，返回格式化后的文本或 null（不支持/失败） */
function formatText(text: string, lang: string): { result: string } | { error: string } {
  switch (lang) {
    case 'json':
    case 'jsonc': {
      try {
        let cleaned = text;
        if (lang === 'jsonc') {
          // 简单移除行注释和块注释
          cleaned = cleaned.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        }
        const parsed = JSON.parse(cleaned);
        return { result: JSON.stringify(parsed, null, 2) + '\n' };
      } catch (e) {
        return { error: `JSON 格式化失败: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'xml':
    case 'svg':
    case 'html':
    case 'htm': {
      return { result: formatXml(text) };
    }
    case 'css': {
      return { result: formatCss(text) };
    }
    default:
      return { error: '不支持该语言的格式化' };
  }
}

/** 简单 XML/HTML 缩进格式化 */
function formatXml(xml: string): string {
  let formatted = '';
  let indent = 0;
  // 按标签分割
  const parts = xml.replace(/>\s*</g, '>\n<').split('\n');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // 关闭标签减少缩进
    if (trimmed.startsWith('</')) indent = Math.max(0, indent - 1);
    formatted += '  '.repeat(indent) + trimmed + '\n';
    // 开启标签增加缩进（排除自关闭和声明）
    if (trimmed.startsWith('<') && !trimmed.startsWith('</') && !trimmed.startsWith('<?') &&
        !trimmed.startsWith('<!') && !trimmed.endsWith('/>') && !/<\/[^>]+>\s*$/.test(trimmed)) {
      indent++;
    }
  }
  return formatted;
}

/** 简单 CSS 格式化 */
function formatCss(css: string): string {
  // 压缩为单行再格式化
  let s = css.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*{\s*/g, ' {\n  ');
  s = s.replace(/\s*}\s*/g, '\n}\n\n');
  s = s.replace(/;\s*/g, ';\n  ');
  // 清理多余空行和行尾空格
  s = s.replace(/\n\s*\n\s*\n/g, '\n\n').replace(/  \n}/g, '\n}').trim() + '\n';
  return s;
}

/** 格式化当前活跃 tab */
function formatActiveTab(): void {
  const tab = activeTabId ? tabs.get(activeTabId) : null;
  if (!tab?.editorView) return;

  const lang = getTabLang(tab);
  const text = tab.editorView.state.doc.toString();
  const result = formatText(text, lang);

  if ('error' in result) {
    setFormatBtnState('error', result.error);
    return;
  }

  // 替换整个文档内容
  tab.editorView.dispatch({
    changes: { from: 0, to: tab.editorView.state.doc.length, insert: result.result },
  });
  setFormatBtnState('success');
}

/** Refresh MD preview pane content from current editor state. */
function refreshMdPreview(tab: TabInfo): void {
  if (!tab.previewOpen) return;
  const pane = tab.wrapperEl.querySelector('.editor-md-preview-pane .editor-md-content');
  if (!pane) return;
  const text = tab.editorView?.state.doc.toString() ?? tab.content;
  pane.innerHTML = renderMarkdown(text);
}

/** Toggle MD preview panel for the given tab. Rebuilds wrapperEl content. */
async function toggleMdPreview(tab: TabInfo): Promise<void> {
  tab.previewOpen = !tab.previewOpen;
  // Preserve current editor content
  if (tab.editorView) {
    tab.content = tab.editorView.state.doc.toString();
    tab.editorView.destroy();
    tab.editorView = null;
  }
  tab.wrapperEl.innerHTML = '';
  tab.wrapperEl.classList.remove('editor-md-split');
  await activateTab(tab.tabId);
  updateStatusBar();
}

/** 更新格式化按钮状态 */
function setFormatBtnState(state: 'success' | 'error', errorMsg?: string): void {
  const btn = document.getElementById('editor-format-btn');
  if (!btn) return;
  const origText = btn.textContent;
  if (state === 'success') {
    btn.textContent = '✓';
    btn.classList.add('success');
  } else {
    btn.textContent = '✗';
    btn.title = errorMsg || '';
    btn.classList.add('error');
  }
  setTimeout(() => {
    btn.textContent = origText;
    btn.title = 'Shift+Alt+F';
    btn.classList.remove('success', 'error');
  }, 2000);
}

function buildExtensions(tab: TabInfo): Extension[] {
  return [
    basicSetup,
    keymap.of([
      { key: 'Mod-s', run: () => { saveTab(tab.tabId); return true; } },
      { key: 'Shift-Alt-f', run: () => { formatActiveTab(); return true; } },
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !tab.isDirty) { tab.isDirty = true; renderTabs(); updateWindowTitle(); }
      if (update.selectionSet || update.docChanged) updateStatusBar();
      if (update.docChanged && tab.previewOpen) refreshMdPreview(tab);
    }),
    tab.wrapCompartment.of(tab.wrapLines ? EditorView.lineWrapping : []),
    ...(isDark ? [oneDark] : []),
  ];
}

/** Toggle soft word-wrap for the given tab without rebuilding the editor. */
function toggleWrapLines(tab: TabInfo): void {
  tab.wrapLines = !tab.wrapLines;
  tab.editorView?.dispatch({
    effects: tab.wrapCompartment.reconfigure(tab.wrapLines ? EditorView.lineWrapping : []),
  });
  updateStatusBar();
}

async function activateTab(tabId: string): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab) return;
  activeTabId = tabId;

  // Show/hide wrappers
  for (const [id, t] of tabs) {
    t.wrapperEl.style.display = id === tabId ? '' : 'none';
  }

  // If not loaded yet, show loading in wrapper
  if (!tab.loaded) {
    if (!tab.editorView) {
      tab.wrapperEl.innerHTML = `<div class="editor-loading">${escapeHtml(t('editorLoading'))}</div>`;
    }
    renderTabs();
    updateWindowTitle();
    return;
  }

  // Create editor/viewer if not yet created
  if (!tab.editorView && !tab.isImage) {
    tab.wrapperEl.innerHTML = '';
    if (tab.previewOpen) {
      // MD split view: editor left, divider, preview right
      tab.wrapperEl.classList.add('editor-md-split');
      const editorPane = document.createElement('div');
      editorPane.className = 'editor-md-editor-pane';
      const divider = document.createElement('div');
      divider.className = 'editor-md-divider';
      const previewPane = document.createElement('div');
      previewPane.className = 'editor-md-preview-pane';
      const previewContent = document.createElement('div');
      previewContent.className = 'editor-md-content';
      previewContent.innerHTML = renderMarkdown(tab.content);
      previewContent.style.fontSize = `${getEditorFontSize()}px`;
      previewPane.appendChild(previewContent);
      tab.wrapperEl.appendChild(editorPane);
      tab.wrapperEl.appendChild(divider);
      tab.wrapperEl.appendChild(previewPane);

      // Drag-to-resize logic
      divider.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const totalW = tab.wrapperEl.getBoundingClientRect().width;
        const startLeftW = editorPane.getBoundingClientRect().width;
        tab.wrapperEl.classList.add('editor-md-resizing');
        const onMove = (me: MouseEvent) => {
          const newLeft = Math.max(160, Math.min(totalW - 160, startLeftW + me.clientX - startX));
          const pct = (newLeft / totalW * 100).toFixed(2);
          editorPane.style.flex = `0 0 ${pct}%`;
          previewPane.style.flex = `0 0 ${(100 - parseFloat(pct)).toFixed(2)}%`;
        };
        const onUp = () => {
          tab.wrapperEl.classList.remove('editor-md-resizing');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      const lang = tab.forcedLang || getLang(tab.fileName, tab.content);
      const langExt = await getLangExt(lang);
      const exts = buildExtensions(tab);
      if (langExt) exts.push(langExt);
      tab.editorView = new EditorView({
        state: EditorState.create({ doc: tab.content, extensions: exts }),
        parent: editorPane,
      });
      const cmEl = editorPane.querySelector('.cm-editor') as HTMLElement;
      if (cmEl) cmEl.style.fontSize = `${getEditorFontSize()}px`;
      const scroller = editorPane.querySelector('.cm-scroller') as HTMLElement | null;
      if (scroller) createOverlayScrollbar({ viewport: scroller, container: scroller, horizontal: true });
      createOverlayScrollbar({ viewport: previewPane, container: previewPane });
    } else {
      // Normal editor (no preview)
      const lang = tab.forcedLang || getLang(tab.fileName, tab.content);
      const langExt = await getLangExt(lang);
      const exts = buildExtensions(tab);
      if (langExt) exts.push(langExt);
      const state = EditorState.create({ doc: tab.content, extensions: exts });
      tab.editorView = new EditorView({ state, parent: tab.wrapperEl });
      const cmEl = tab.wrapperEl.querySelector('.cm-editor') as HTMLElement;
      if (cmEl) cmEl.style.fontSize = `${getEditorFontSize()}px`;
      const scroller = tab.wrapperEl.querySelector('.cm-scroller') as HTMLElement | null;
      if (scroller) createOverlayScrollbar({ viewport: scroller, container: scroller, horizontal: true });
    }
  } else if (tab.isImage && !tab.wrapperEl.querySelector('.editor-image-view')) {
    // Image view
    tab.wrapperEl.innerHTML = '';
    const imageView = document.createElement('div');
    imageView.className = 'editor-image-view';
    const img = document.createElement('img');
    img.src = tab.content; // data URL
    img.alt = tab.fileName;
    img.className = 'editor-image-preview';
    imageView.appendChild(img);
    tab.wrapperEl.appendChild(imageView);
  }

  tab.editorView?.requestMeasure();
  renderTabs();
  updateWindowTitle();
  updateStatusBar();
}

async function closeTab(tabId: string): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab) return;
  if (tab.isDirty) {
    const ok = await confirm(t('editorUnsavedChanges'), { title: tab.fileName, kind: 'warning' });
    if (!ok) return;
  }
  if (tab.editorView) tab.editorView.destroy();
  tab.wrapperEl.remove();
  tabs.delete(tabId);
  void emitTo(tab.ownerLabel, EDITOR_TAB_CLOSED_EVENT, { tabId } satisfies EditorTabClosed);
  if (tabs.size === 0) {
    void getCurrentWindow().close();
    return;
  }
  if (activeTabId === tabId) void activateTab(tabs.keys().next().value!);
  else renderTabs();
}

function saveTab(tabId: string): void {
  const tab = tabs.get(tabId);
  if (!tab || !tab.filePath || !tab.editorView || tab.isImage || tab.isSaving) return;
  const content = tab.editorView.state.doc.toString();
  if (!editorTextFitsLimit(content)) {
    setSaveBtnState('failed');
    return;
  }
  tab.isSaving = true;
  setSaveBtnState('saving');
  void emitTo(tab.ownerLabel, EDITOR_SAVE_REQUEST_EVENT, {
    tabId,
    content,
  } satisfies EditorSaveRequest).catch(() => {
    if (tabs.get(tabId) === tab) {
      tab.isSaving = false;
      setSaveBtnState('failed');
    }
  });
}

/** Update the save button state text, auto-reset after 3s */
function setSaveBtnState(state: 'saving' | 'saved' | 'failed' | 'timeout'): void {
  const btn = document.getElementById('editor-save-btn');
  if (!btn) return;
  const labels: Record<string, string> = {
    saving: t('editorSaving'),
    saved: t('editorSaved'),
    failed: t('editorSaveFailed'),
    timeout: t('editorSaveFailed'),
  };
  btn.textContent = labels[state] || state;
  btn.classList.toggle('saving', state === 'saving');
  btn.classList.toggle('success', state === 'saved');
  btn.classList.toggle('error', state === 'failed' || state === 'timeout');
  if (state !== 'saving') {
    setTimeout(() => {
      if (btn.textContent !== t('editorSaving')) {
        btn.textContent = navigator.userAgent.includes('Windows') ? 'Ctrl+S' : '⌘S';
        btn.classList.remove('success', 'error');
      }
    }, 3000);
  }
}

// ── Tab strip widths ──
//
// Editor tabs show their full `host:/path` whenever the row can hold it and trim
// only under pressure. The opposite default applies app-wide: `.title-tab` caps
// itself at 340px for the toolbar's short connection names, which is far too
// narrow for a path — file-editor.css lifts that cap for this strip.
//
// The allocation itself is planTabWidths(), shared with the window tab strip, so
// both rows water-fill the same way: short labels keep their natural width while
// the longest ones are trimmed to a uniform cap, and only when even the floors do
// not fit does the row scroll.

/** Text a tab may shrink to before the row scrolls (≈3 CJK / 6 Latin at 12px). */
const EDITOR_MIN_TEXT_WIDTH = 44;
/** Keeps the last glyph clear of the close button. */
const EDITOR_TEXT_TAIL_SLACK = 6;

function applyEditorTabWidths(): void {
  const nodes = Array.from(tabBarEl.querySelectorAll('.title-tab')) as HTMLButtonElement[];
  if (nodes.length === 0) return;

  const barStyle = getComputedStyle(tabBarEl);
  const gap = Number.parseFloat(barStyle.columnGap) || 0;
  const available = Math.max(
    0,
    tabBarEl.clientWidth
      - (Number.parseFloat(barStyle.paddingLeft) || 0)
      - (Number.parseFloat(barStyle.paddingRight) || 0),
  );

  // Everything that is not the title: padding, borders and the close button.
  // Measured rather than assumed, so it stays correct if any of them changes.
  const measured = nodes.map((node) => {
    const style = getComputedStyle(node);
    const paddingX = (Number.parseFloat(style.paddingLeft) || 0)
      + (Number.parseFloat(style.paddingRight) || 0);
    const borderX = (Number.parseFloat(style.borderLeftWidth) || 0)
      + (Number.parseFloat(style.borderRightWidth) || 0);
    const closeEl = node.querySelector('.tab-close') as HTMLElement | null;
    const closeWidth = closeEl ? closeEl.offsetWidth : 0;
    const chrome = paddingX + borderX + closeWidth;
    const slack = closeWidth > 0 ? EDITOR_TEXT_TAIL_SLACK : 0;
    // scrollWidth reports the title's full width even while it is ellipsised.
    const textWidth = node.querySelector('.title-tab-text')?.scrollWidth ?? 0;
    return {
      full: Math.ceil(textWidth + chrome + slack),
      min: Math.ceil(Math.min(textWidth, EDITOR_MIN_TEXT_WIDTH) + chrome + slack),
    };
  });

  const plan = planTabWidths({
    fullWidths: measured.map((m) => m.full),
    minWidths: measured.map((m) => m.min),
    available,
    gap,
  });

  nodes.forEach((node, index) => {
    node.style.width = `${plan.widths[index]}px`;
  });
}

function renderTabs(): void {
  tabBarEl.innerHTML = '';
  for (const [id, tab] of tabs) {
    const isActive = id === activeTabId;
    const label = `${tab.isDirty ? '● ' : ''}${tab.host}:${tab.filePath}`;
    const btn = document.createElement('button');
    btn.className = `title-tab${isActive ? ' active' : ''}`;
    btn.title = `${tab.host}:${tab.filePath}`;
    // Lets a right-click on the tab find out which tab it landed on.
    btn.dataset.tabId = id;
    btn.addEventListener('click', () => void activateTab(id));
    // One text node inside the clipping track: `.title-tab-text` caps itself at
    // 100% of the track, so the ellipsis appears exactly when the planned width
    // is narrower than the label. No marquee duplicate — the row prefers full
    // paths and shrinks under pressure instead (see applyEditorTabWidths).
    const trackOuter = document.createElement('span');
    trackOuter.className = 'title-tab-track';
    const textSpan = document.createElement('span');
    textSpan.className = 'title-tab-text';
    textSpan.textContent = label;
    trackOuter.appendChild(textSpan);
    btn.appendChild(trackOuter);
    const closeBtn = document.createElement('span');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1l6 6M7 1l-6 6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); void closeTab(id); });
    btn.appendChild(closeBtn);
    tabBarEl.appendChild(btn);
  }
  // Must run after insertion: the measurement reads scrollWidth off live nodes.
  applyEditorTabWidths();
}

function updateWindowTitle(): void {
  const tab = activeTabId ? tabs.get(activeTabId) : null;
  if (!tab) { void getCurrentWindow().setTitle('MeTerm Editor'); return; }
  void getCurrentWindow().setTitle(`${tab.isDirty ? '● ' : ''}${tab.fileName} — MeTerm`);
}

const LANG_OPTIONS = [
  { id: '', label: 'Plain Text' },
  { id: 'js', label: 'JavaScript' }, { id: 'ts', label: 'TypeScript' },
  { id: 'json', label: 'JSON' }, { id: 'py', label: 'Python' },
  { id: 'yaml', label: 'YAML' }, { id: 'sql', label: 'SQL' },
  { id: 'html', label: 'HTML' }, { id: 'css', label: 'CSS' },
  { id: 'md', label: 'Markdown' }, { id: 'sh', label: 'Shell' },
  { id: 'xml', label: 'XML' }, { id: 'java', label: 'Java' },
  { id: 'go', label: 'Go' }, { id: 'rs', label: 'Rust' },
  { id: 'cpp', label: 'C/C++' }, { id: 'php', label: 'PHP' },
  { id: 'rb', label: 'Ruby' }, { id: 'lua', label: 'Lua' },
  { id: 'toml', label: 'TOML' }, { id: 'dockerfile', label: 'Dockerfile' },
  { id: 'properties', label: 'Properties' },
];

async function switchLanguage(tab: TabInfo, langId: string): Promise<void> {
  tab.forcedLang = langId;
  if (!tab.editorView) return;
  // Recreate editor with new language
  const content = tab.editorView.state.doc.toString();
  tab.editorView.destroy();
  tab.wrapperEl.innerHTML = '';
  const lang = langId || getLang(tab.fileName, content);
  const langExt = await getLangExt(lang);
  const exts = buildExtensions(tab);
  if (langExt) exts.push(langExt);
  tab.editorView = new EditorView({
    state: EditorState.create({ doc: content, extensions: exts }),
    parent: tab.wrapperEl,
  });
  const scroller = tab.wrapperEl.querySelector('.cm-scroller') as HTMLElement | null;
  if (scroller) scroller.classList.add('editor-cm-scroller');
  updateStatusBar();
}

function updateStatusBar(): void {
  const tab = activeTabId ? tabs.get(activeTabId) : null;
  if (!tab) { statusBarEl.textContent = ''; return; }

  // Image tab: show image info only, no editor controls
  if (tab.isImage) {
    statusBarEl.innerHTML = '';
    statusBarEl.dataset.mode = 'image'; // Mark so text mode forces rebuild
    const infoSpan = document.createElement('span');
    infoSpan.className = 'editor-info';
    infoSpan.textContent = `${tab.mimeType}  ·  ${t('editorReadOnly')}`;
    statusBarEl.appendChild(infoSpan);
    return;
  }

  if (!tab.editorView) { statusBarEl.textContent = ''; return; }
  const state = tab.editorView.state;
  const cursor = state.selection.main.head;
  const line = state.doc.lineAt(cursor);
  const col = cursor - line.from + 1;
  const lang = tab.forcedLang || getLang(tab.fileName, tab.editorView.state.doc.toString());
  const langLabel = LANG_OPTIONS.find(l => l.id === lang)?.label || lang.toUpperCase() || 'Plain Text';

  // If switching from image mode → text mode, force a full rebuild
  // so buttons (save, format, wrap, etc.) are recreated.
  const wasImage = statusBarEl.dataset.mode === 'image';
  if (wasImage) delete statusBarEl.dataset.mode;

  // Update or create elements (avoid full innerHTML rebuild to preserve button state)
  let infoSpan = statusBarEl.querySelector('.editor-info') as HTMLElement | null;
  if (!infoSpan || wasImage) {
    statusBarEl.innerHTML = '';
    infoSpan = document.createElement('span');
    infoSpan.className = 'editor-info';
    statusBarEl.appendChild(infoSpan);

    // Spacer
    const spacer = document.createElement('span');
    spacer.className = 'editor-status';
    statusBarEl.appendChild(spacer);

    // Font size button
    const fontBtn = document.createElement('button');
    fontBtn.className = 'editor-font-btn';
    fontBtn.textContent = `${getEditorFontSize()}px`;
    fontBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showFontSizePicker(fontBtn);
    });
    statusBarEl.appendChild(fontBtn);

    // Format button
    const formatBtn = document.createElement('button');
    formatBtn.id = 'editor-format-btn';
    formatBtn.className = 'editor-format-btn';
    formatBtn.textContent = t('editorFormat');
    formatBtn.title = 'Shift+Alt+F';
    formatBtn.addEventListener('click', () => formatActiveTab());
    statusBarEl.appendChild(formatBtn);

    // Language selector
    const langBtn = document.createElement('button');
    langBtn.className = 'editor-lang-btn';
    langBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentTab = activeTabId ? tabs.get(activeTabId) : null;
      if (currentTab) showLangPicker(langBtn, currentTab);
    });
    statusBarEl.appendChild(langBtn);

    // Word wrap toggle button
    const wrapBtn = document.createElement('button');
    wrapBtn.id = 'editor-wrap-btn';
    wrapBtn.className = 'editor-wrap-btn';
    wrapBtn.title = t('editorWordWrap');
    wrapBtn.addEventListener('click', () => {
      const currentTab = activeTabId ? tabs.get(activeTabId) : null;
      if (currentTab) toggleWrapLines(currentTab);
    });
    statusBarEl.appendChild(wrapBtn);

    // MD Preview toggle button
    const previewBtn = document.createElement('button');
    previewBtn.id = 'editor-preview-btn';
    previewBtn.className = 'editor-preview-btn';
    previewBtn.title = t('editorMdPreview');
    previewBtn.addEventListener('click', () => {
      const currentTab = activeTabId ? tabs.get(activeTabId) : null;
      if (currentTab) void toggleMdPreview(currentTab);
    });
    statusBarEl.appendChild(previewBtn);

    // Save button
    const saveBtn = document.createElement('button');
    saveBtn.id = 'editor-save-btn';
    saveBtn.className = 'editor-save-btn';
    saveBtn.textContent = navigator.userAgent.includes('Windows') ? 'Ctrl+S' : '⌘S';
    saveBtn.addEventListener('click', () => {
      if (activeTabId) saveTab(activeTabId);
    });
    statusBarEl.appendChild(saveBtn);
  }

  infoSpan.textContent = `Ln ${line.number}, Col ${col}  ·  ${state.doc.lines} lines  ·  UTF-8`;

  // Update language label
  const langBtn = statusBarEl.querySelector('.editor-lang-btn');
  if (langBtn) langBtn.textContent = langLabel;

  // Update format button visibility (only for formattable languages)
  const formatBtn = document.getElementById('editor-format-btn');
  if (formatBtn) {
    formatBtn.style.display = tab && canFormat(tab) ? '' : 'none';
  }

  // Update font size label
  const fontBtn = statusBarEl.querySelector('.editor-font-btn');
  if (fontBtn) fontBtn.textContent = `${getEditorFontSize()}px`;

  // Update word wrap button state
  const wrapBtn = document.getElementById('editor-wrap-btn');
  if (wrapBtn) {
    wrapBtn.textContent = t('editorWordWrap');
    wrapBtn.classList.toggle('active', tab.wrapLines);
  }

  // Update MD preview button: show only for markdown files, indicate active state
  const previewBtn = document.getElementById('editor-preview-btn');
  if (previewBtn) {
    const isMd = (tab.forcedLang || getLang(tab.fileName, tab.editorView?.state.doc.toString() ?? tab.content)) === 'md';
    previewBtn.style.display = isMd ? '' : 'none';
    previewBtn.textContent = tab.previewOpen ? t('editorMdPreviewOff') : t('editorMdPreview');
    previewBtn.classList.toggle('active', tab.previewOpen);
  }
}

// --- Editor font size ---
const FONT_SIZE_KEY = 'meterm-editor-font-size';
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;

function getEditorFontSize(): number {
  const saved = localStorage.getItem(FONT_SIZE_KEY);
  return saved ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, parseInt(saved, 10) || DEFAULT_FONT_SIZE)) : DEFAULT_FONT_SIZE;
}

function setEditorFontSize(size: number): void {
  size = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
  localStorage.setItem(FONT_SIZE_KEY, String(size));
  // Apply to all open editors and MD preview panes
  for (const tab of tabs.values()) {
    if (tab.wrapperEl) {
      const cm = tab.wrapperEl.querySelector('.cm-editor') as HTMLElement;
      if (cm) cm.style.fontSize = `${size}px`;
      const mdContent = tab.wrapperEl.querySelector('.editor-md-content') as HTMLElement | null;
      if (mdContent) mdContent.style.fontSize = `${size}px`;
    }
  }
  updateStatusBar();
}

function showFontSizePicker(anchor: HTMLElement): void {
  // Remove existing picker
  document.querySelector('.editor-font-picker')?.remove();

  const picker = document.createElement('div');
  picker.className = 'editor-font-picker';

  const currentSize = getEditorFontSize();

  const minusBtn = document.createElement('button');
  minusBtn.textContent = '−';
  minusBtn.className = 'font-picker-btn';
  minusBtn.onclick = (e) => { e.stopPropagation(); setEditorFontSize(getEditorFontSize() - 1); sizeLabel.textContent = `${getEditorFontSize()}px`; };

  const sizeLabel = document.createElement('span');
  sizeLabel.className = 'font-picker-label';
  sizeLabel.textContent = `${currentSize}px`;

  const plusBtn = document.createElement('button');
  plusBtn.textContent = '+';
  plusBtn.className = 'font-picker-btn';
  plusBtn.onclick = (e) => { e.stopPropagation(); setEditorFontSize(getEditorFontSize() + 1); sizeLabel.textContent = `${getEditorFontSize()}px`; };

  picker.appendChild(minusBtn);
  picker.appendChild(sizeLabel);
  picker.appendChild(plusBtn);

  // Position above anchor
  const rect = anchor.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  picker.style.left = `${rect.left}px`;

  document.body.appendChild(picker);

  // Close on outside click
  const close = (e: MouseEvent) => {
    if (!picker.contains(e.target as Node) && e.target !== anchor) {
      picker.remove();
      document.removeEventListener('mousedown', close);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

function showLangPicker(anchor: HTMLElement, tab: TabInfo): void {
  // Remove existing picker
  document.querySelector('.editor-lang-picker')?.remove();

  const picker = document.createElement('div');
  picker.className = 'editor-lang-picker';

  for (const opt of LANG_OPTIONS) {
    const item = document.createElement('div');
    item.className = `editor-lang-item${opt.id === (tab.forcedLang || '') ? ' active' : ''}`;
    item.textContent = opt.label;
    item.addEventListener('click', () => {
      picker.remove();
      void switchLanguage(tab, opt.id);
    });
    picker.appendChild(item);
  }

  // Position above the anchor
  const rect = anchor.getBoundingClientRect();
  picker.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  picker.style.right = `${window.innerWidth - rect.right}px`;
  document.body.appendChild(picker);

  // Close on click outside
  const close = (e: MouseEvent) => {
    if (!picker.contains(e.target as Node)) {
      picker.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function showTabError(tab: TabInfo, error: string): void {
  tab.content = '';
  tab.loaded = true;
  tab.wrapperEl.replaceChildren();
  const message = document.createElement('div');
  message.className = 'editor-error';
  message.textContent = error.slice(0, 512);
  tab.wrapperEl.appendChild(message);
}

function validOpenPayload(item: EditorOpen): boolean {
  return Boolean(item)
    && isValidEditorNonce(item.tabId)
    && isSafeEditorWindowLabel(item.ownerLabel)
    && typeof item.sessionId === 'string' && item.sessionId.length <= 256
    && typeof item.filePath === 'string' && item.filePath.length > 0 && item.filePath.length <= 65_536
    && typeof item.fileName === 'string' && item.fileName.length > 0 && item.fileName.length <= 1_024
    && typeof item.host === 'string' && item.host.length <= 1_024
    && typeof item.isImage === 'boolean'
    && typeof item.mimeType === 'string' && item.mimeType.length <= 128;
}

function handleOpen(item: EditorOpen): void {
  if (!validOpenPayload(item)) return;
  if (!tabs.has(item.tabId)) {
    const wrapper = document.createElement('div');
    wrapper.className = 'editor-tab-content';
    wrapper.style.display = 'none';
    contentEl.appendChild(wrapper);
    const image = item.isImage && isImageFile(item.fileName);
    const markdown = !image
      && (item.fileName.toLowerCase().endsWith('.md')
        || item.fileName.toLowerCase().endsWith('.markdown'));
    tabs.set(item.tabId, {
      ...item,
      editorView: null,
      wrapperEl: wrapper,
      isDirty: false,
      isSaving: false,
      content: '',
      loaded: false,
      forcedLang: '',
      isImage: image,
      mimeType: image ? item.mimeType : '',
      previewOpen: markdown,
      wrapLines: false,
      wrapCompartment: new Compartment(),
    });
  }
  void activateTab(item.tabId);
}

function handleContent(data: EditorContent): void {
  if (!data || !isValidEditorNonce(data.tabId)) return;
  const tab = tabs.get(data.tabId);
  if (!tab || tab.loaded) return;
  if (typeof data.error === 'string') {
    showTabError(tab, data.error || 'Unable to read file');
    return;
  }
  if (typeof data.content !== 'string') {
    showTabError(tab, 'Invalid response from main window');
    return;
  }

  if (tab.isImage) {
    const maxDataUrlChars = Math.ceil(MAX_EDITOR_FILE_BYTES * 4 / 3) + 256;
    const expectedPrefix = `data:${tab.mimeType};base64,`;
    if (data.content.length > maxDataUrlChars || !data.content.startsWith(expectedPrefix)) {
      showTabError(tab, 'Invalid image response from main window');
      return;
    }
  } else if (!editorTextFitsLimit(data.content)) {
    showTabError(tab, 'File exceeds editor size limit');
    return;
  }
  tab.loaded = true;
  tab.content = data.content;
  if (data.tabId === activeTabId) void activateTab(data.tabId);
}

function handleSaveResult(result: EditorSaveResult): void {
  if (!result || !isValidEditorNonce(result.tabId) || typeof result.success !== 'boolean') return;
  const tab = tabs.get(result.tabId);
  if (!tab || !tab.isSaving) return;
  tab.isSaving = false;
  if (result.success) {
    tab.isDirty = false;
    renderTabs();
    updateWindowTitle();
  }
  if (result.tabId === activeTabId) setSaveBtnState(result.success ? 'saved' : 'failed');
}

// ── Right-click menu ──
//
// This window owns its context menu rather than letting WebKit supply one. The
// default menu's labels come from the system (English regardless of the app
// language), and its "Reload" discards this window's entire view state while the
// main window's file bridge keeps believing the tab is still open — after which
// reopening that file only ever shows "Loading...". See editor-menu-model.ts.

/** Text selected in the tab's editor, or '' when the view holds no selection. */
function selectedText(tab: TabInfo): string {
  const view = tab.editorView;
  if (!view) return '';
  const range = view.state.selection.main;
  return range.empty ? '' : view.state.sliceDoc(range.from, range.to);
}

/** Language id after the user's manual override — same rule as the status bar. */
function effectiveLang(tab: TabInfo): string {
  return tab.forcedLang
    || getLang(tab.fileName, tab.editorView?.state.doc.toString() ?? tab.content);
}

async function copySelection(tab: TabInfo): Promise<void> {
  const text = selectedText(tab);
  if (text) await clipboardWriteText(text);
}

async function cutSelection(tab: TabInfo): Promise<void> {
  const view = tab.editorView;
  const text = selectedText(tab);
  if (!view || !text) return;
  // Clipboard first: if the write rejects, the text must not already be gone.
  await clipboardWriteText(text);
  view.dispatch(view.state.replaceSelection(''));
  view.focus();
}

async function pasteIntoSelection(tab: TabInfo): Promise<void> {
  const view = tab.editorView;
  if (!view) return;
  const text = await clipboardReadText();
  if (!text) return;
  view.dispatch(view.state.replaceSelection(text));
  view.focus();
}

function selectAllText(tab: TabInfo): void {
  const view = tab.editorView;
  if (!view) return;
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  view.focus();
}

/**
 * Close a batch of tabs, stopping at the first one that refuses.
 *
 * `closeTab` asks before discarding unsaved edits and simply returns when the
 * answer is no. Without the re-check below the loop would carry on and close the
 * remaining tabs behind that decision, so `tabs` is read again after each await.
 */
async function closeTabsByIds(ids: readonly string[], keepActiveId?: string): Promise<void> {
  for (const id of ids) {
    if (!tabs.has(id)) continue;
    await closeTab(id);
    if (tabs.has(id)) return;
  }
  if (keepActiveId && tabs.has(keepActiveId)) void activateTab(keepActiveId);
}

function runEditorMenuCommand(command: EditorMenuCommand, targetTabId?: string): void {
  const tab = targetTabId
    ? tabs.get(targetTabId)
    : (activeTabId ? tabs.get(activeTabId) : null);
  if (!tab) return;
  // The tab menu acts on the tab that was clicked, which need not be the active
  // one, so the ordering comes from the live map rather than from activeTabId.
  const order = [...tabs.keys()];
  const index = order.indexOf(tab.tabId);
  switch (command) {
    case 'cut': void cutSelection(tab); return;
    case 'copy': void copySelection(tab); return;
    case 'paste': void pasteIntoSelection(tab); return;
    case 'selectAll': selectAllText(tab); return;
    case 'save': saveTab(tab.tabId); return;
    case 'closeTab': void closeTab(tab.tabId); return;
    case 'closeOthers':
      void closeTabsByIds(order.filter((id) => id !== tab.tabId), tab.tabId);
      return;
    case 'closeLeft':
      void closeTabsByIds(order.slice(0, index), tab.tabId);
      return;
    case 'closeRight':
      void closeTabsByIds(order.slice(index + 1), tab.tabId);
      return;
    // The last close shuts the window, which is what an empty editor window
    // would amount to anyway.
    case 'closeAll': void closeTabsByIds(order); return;
    case 'wordWrap': toggleWrapLines(tab); return;
    case 'mdPreview': void toggleMdPreview(tab); return;
    case 'format': formatActiveTab(); return;
  }
}

function openEditorContextMenu(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  // A right-click in the title bar is about tabs, not about the document: on a
  // tab it targets that tab, anywhere else along the bar it targets the active
  // one. The editor body and the status bar keep the document menu.
  const tabEl = target?.closest?.('.title-tab') as HTMLElement | null;
  const onTitleBar = tabEl !== null || target?.closest?.('.editor-tab-bar') != null;

  const tab = tabEl?.dataset.tabId
    ? tabs.get(tabEl.dataset.tabId) ?? null
    : (activeTabId ? tabs.get(activeTabId) : null);

  if (!tab) {
    // Nothing to act on — but still keep WebKit's default menu out of this window.
    event.preventDefault();
    return;
  }

  if (onTitleBar) {
    const order = [...tabs.keys()];
    showEditorContextMenu(
      event,
      buildEditorTabMenu(
        { tabIndex: order.indexOf(tab.tabId), tabCount: order.length },
        detectMacPlatform(navigator.userAgent),
      ),
      (command) => runEditorMenuCommand(command, tab.tabId),
    );
    return;
  }

  const range = tab.editorView?.state.selection.main;
  showEditorContextMenu(
    event,
    buildEditorMenu(
      {
        isImage: tab.isImage,
        hasSelection: !!range && !range.empty,
        isMarkdown: effectiveLang(tab) === 'md',
        wrapLines: tab.wrapLines,
        previewOpen: tab.previewOpen,
        canFormat: canFormat(tab),
      },
      detectMacPlatform(navigator.userAgent),
    ),
    (command) => runEditorMenuCommand(command),
  );
}

/**
 * Identifies this *page load* of the editor window, and changes whenever the
 * view is rebuilt. The owner windows keep their own record of it so they can
 * tell that the tabs they think are on screen no longer exist; see the pong
 * handler in file-editor-bridge.ts.
 *
 * Minted lazily: a throw here must never be able to stop the module from
 * loading, and the fallback simply fails validation on the other side, which is
 * read as "no information" rather than "new view".
 */
let editorViewInstanceId: string | null = null;
function currentEditorViewId(): string {
  if (editorViewInstanceId) return editorViewInstanceId;
  try {
    editorViewInstanceId = crypto.randomUUID();
  } catch {
    editorViewInstanceId = `view-${Date.now().toString(36)}`;
  }
  return editorViewInstanceId;
}

async function installEditorEventListeners(): Promise<void> {
  // Register all data handlers before answering the readiness handshake. This
  // guarantees the first open/content event cannot be lost during startup.
  await Promise.all([
    listen<EditorOpen>(EDITOR_OPEN_EVENT, event => handleOpen(event.payload)),
    listen<EditorContent>(EDITOR_CONTENT_EVENT, event => handleContent(event.payload)),
    listen<EditorSaveResult>(EDITOR_SAVE_RESULT_EVENT, event => handleSaveResult(event.payload)),
    listen<EditorDisconnected>(EDITOR_DISCONNECTED_EVENT, event => {
      const tabId = event.payload?.tabId;
      if (!isValidEditorNonce(tabId)) return;
      const tab = tabs.get(tabId);
      if (!tab) return;
      tab.isSaving = false;
      if (!tab.loaded) showTabError(tab, 'Session disconnected');
      if (tabId === activeTabId) setSaveBtnState('failed');
    }),
  ]);
  await listen<EditorMainCloseRequest>(EDITOR_MAIN_CLOSE_REQUEST_EVENT, async event => {
    const request = event.payload;
    if (!isValidEditorNonce(request?.requestId)
        || !(request.requesterLabel === 'main'
          || /^window-[A-Za-z0-9-]{1,64}$/.test(request.requesterLabel))) return;
    let replied = false;
    try {
      const dirty = [...tabs.values()].some(tab => tab.isDirty);
      const accepted = !dirty || await confirm(t('editorUnsavedChanges'), {
        title: 'MeTerm Editor', kind: 'warning',
      });
      const reply: EditorMainCloseResult = { requestId: request.requestId, accepted };
      if (!accepted) {
        await emitTo(request.requesterLabel, EDITOR_MAIN_CLOSE_RESULT_EVENT, reply);
        return;
      }

      // A native close() resolves when requested, not when the editor's own
      // asynchronous close confirmation finishes. This request already has the
      // user's answer, so notify owners and destroy the window explicitly.
      const owners = new Set([...tabs.values()].map(tab => tab.ownerLabel));
      await Promise.all([...owners].map(owner => (
        emitTo(owner, EDITOR_WINDOW_CLOSED_EVENT, {}).catch(() => {})
      )));
      await emitTo(request.requesterLabel, EDITOR_MAIN_CLOSE_RESULT_EVENT, reply);
      replied = true;
      await getCurrentWindow().destroy();
    } catch (error) {
      console.error('Unable to close editor for main-window exit:', error);
      if (!replied) {
        await emitTo(request.requesterLabel, EDITOR_MAIN_CLOSE_RESULT_EVENT, {
          requestId: request.requestId, accepted: false,
        } satisfies EditorMainCloseResult).catch(() => {});
      }
    }
  });
  // Answer readiness pings only after every request handler is installed.
  await listen<EditorPing>(EDITOR_PING_EVENT, event => {
    const payload = event.payload;
    if (!payload || !isSafeEditorWindowLabel(payload.ownerLabel)
        || !isValidEditorNonce(payload.requestId)) return;
    void emitTo(payload.ownerLabel, EDITOR_PONG_EVENT, {
      requestId: payload.requestId,
      viewId: currentEditorViewId(),
    });
  });
}

export async function initEditorContent(): Promise<void> {
  purgeLegacyEditorStorage(localStorage);
  const settings = loadSettings();
  isDark = resolveThemeAttr(settings.colorScheme) !== 'light';

  import('./styles/file-editor.css');

  // Tab bar was created synchronously by file-editor-init.ts
  tabBarEl = document.getElementById('editor-tabs-area')!;

  // Container for editor panels + status bar
  const container = document.createElement('div');
  container.id = 'editor-window-container';
  document.body.appendChild(container);

  // Content wrapper (each tab adds its own child div)
  contentEl = document.createElement('div');
  contentEl.className = 'editor-content';
  container.appendChild(contentEl);

  // Status bar
  statusBarEl = document.createElement('div');
  statusBarEl.className = 'editor-statusbar';
  container.appendChild(statusBarEl);

  await getCurrentWindow().onCloseRequested(async (event) => {
    const dirty = [...tabs.values()].filter(tab => tab.isDirty);
    if (dirty.length > 0) {
      const ok = await confirm(t('editorUnsavedChanges'), { title: 'MeTerm Editor', kind: 'warning' });
      if (!ok) { event.preventDefault(); return; }
    }
    const owners = new Set([...tabs.values()].map(tab => tab.ownerLabel));
    await Promise.all([...owners].map(owner => (
      emitTo(owner, EDITOR_WINDOW_CLOSED_EVENT, {}).catch(() => {})
    )));
  });

  await installEditorEventListeners();

  // One listener for the whole window — tab strip, editor body and status bar
  // alike — so WebKit's default menu can never surface anywhere in it.
  document.addEventListener('contextmenu', openEditorContextMenu);

  // Re-plan on resize: a wider window can show more of each path.
  window.addEventListener('resize', () => requestAnimationFrame(applyEditorTabWidths));

  await revealAfterPaint(getCurrentWindow().label);
}
