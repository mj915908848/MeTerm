/**
 * ai-capsule-layout.ts — AI chat panel layout mode management
 *
 * Handles switching between bottom panel mode and side panel mode.
 * In side mode, the chat panel moves to a right-side panel in #main-content.
 * The AI Bar stays in #terminal-panel (agent buttons hidden via CSS class),
 * and the side panel has its own independent input area for LLM chat.
 */

import { TerminalRegistry } from './terminal';
import { t } from './i18n';
import { LLM_SEND_SVG } from './ai-capsule-chat-ui';
import { stopIcon } from './ai-icons';
import type { AICapsuleInstance, AIChatLayoutMode } from './ai-capsule-types';

// ── Constants ──

const LS_LAYOUT_KEY = 'meterm-ai-layout-mode';
const LS_SIDE_WIDTH_KEY = 'meterm-ai-side-width';
const DEFAULT_SIDE_WIDTH = 480;
const SIDE_MIN_WIDTH = 280;
const SIDE_MAX_WIDTH = 600;
const SIDE_MIN_RATIO = 0.20;
const SIDE_MAX_RATIO = 0.45;

// ── SVG icons ──

export const SVG_LAYOUT_SIDE = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="14" height="12" rx="2"/><line x1="10" y1="2" x2="10" y2="14"/></svg>`;
export const SVG_LAYOUT_BOTTOM = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="14" height="12" rx="2"/><line x1="1" y1="10" x2="15" y2="10"/></svg>`;

// ── Persistence ──

export function getSavedLayoutMode(): AIChatLayoutMode {
  // Chat is sidebar-only now — the bottom-panel mode has been retired, so the
  // chat always opens as the right-side panel regardless of any saved value.
  return 'side';
}

export function saveLayoutMode(mode: AIChatLayoutMode): void {
  localStorage.setItem(LS_LAYOUT_KEY, mode);
}

export function getSavedSideWidth(): number {
  const saved = localStorage.getItem(LS_SIDE_WIDTH_KEY);
  if (saved) {
    const w = parseInt(saved);
    if (!isNaN(w) && w > 0) return w;
  }
  return DEFAULT_SIDE_WIDTH;
}

export function saveSideWidth(width: number): void {
  localStorage.setItem(LS_SIDE_WIDTH_KEY, String(Math.round(width)));
}

// ── Panel bounds ──

export function getSidePanelBounds(): { min: number; max: number } {
  const mainContent = document.getElementById('main-content');
  if (!mainContent) return { min: SIDE_MIN_WIDTH, max: SIDE_MAX_WIDTH };

  const totalW = mainContent.offsetWidth;
  const jsPanel = document.getElementById('jumpserver-panel');
  const jsWidth = jsPanel && jsPanel.style.display !== 'none' ? jsPanel.offsetWidth : 0;
  const jsHandle = mainContent.querySelector('.js-panel-resize-handle') as HTMLElement | null;
  const jsHandleW = jsHandle && jsHandle.style.display !== 'none' ? jsHandle.offsetWidth : 0;

  const available = totalW - jsWidth - jsHandleW;
  return {
    min: Math.max(SIDE_MIN_WIDTH, Math.round(available * SIDE_MIN_RATIO)),
    max: Math.min(SIDE_MAX_WIDTH, Math.round(available * SIDE_MAX_RATIO)),
  };
}

// ── Side panel creation ──

function createSidePanel(): { panel: HTMLDivElement; handle: HTMLDivElement } {
  const panel = document.createElement('div');
  panel.className = 'ai-side-panel';

  const handle = document.createElement('div');
  handle.className = 'ai-side-resize-handle';

  return { panel, handle };
}

// ── Resize handle ──

let sideWidth = getSavedSideWidth();

function setupSideResize(handle: HTMLDivElement, panel: HTMLDivElement): void {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = sideWidth;
    const mainContent = document.getElementById('main-content');
    if (mainContent) mainContent.classList.add('ai-side-resizing');

    const onMove = (ev: PointerEvent) => {
      const delta = startX - ev.clientX;
      const { min, max } = getSidePanelBounds();
      sideWidth = Math.max(min, Math.min(max, startWidth + delta));
      panel.style.width = `${sideWidth}px`;
    };
    const onUp = () => {
      if (mainContent) mainContent.classList.remove('ai-side-resizing');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      saveSideWidth(sideWidth);
      TerminalRegistry.resizeAll();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

// ── Side input area ──

export interface SideInputCallbacks {
  sendToLLM: (instance: AICapsuleInstance, text: string) => boolean;
  buildModelDropdown: (dropdown: HTMLDivElement, label: HTMLSpanElement) => void;
  updateModelLabel: (label: HTMLSpanElement) => void;
  createThinkingToggle: () => HTMLDivElement;
  toggleLayout: (instance: AICapsuleInstance) => void;
  /**
   * Resolve the instance that should own the *current* action
   * (send / abort / chat history / layout toggle). Used by side
   * panel callbacks because the side panel is tab-scoped: it lives
   * longer than any single pane and must operate on whichever
   * pane has the live focus right now — not the pane that created
   * the side panel.
   */
  resolveCurrentInstance: (fallback: AICapsuleInstance) => AICapsuleInstance;
}

/**
 * Create the side panel composer and its per-request options.
 */
export function createSideInputArea(
  instance: AICapsuleInstance,
  callbacks: SideInputCallbacks,
): HTMLDivElement {
  const area = document.createElement('div');
  area.className = 'ai-side-input-area';

  const toolbar = document.createElement('div');
  toolbar.className = 'ai-side-input-toolbar';

  const modelSelect = document.createElement('div');
  modelSelect.className = 'ai-side-model-select';

  const modelLabel = document.createElement('span');
  modelLabel.className = 'ai-side-model-label';
  callbacks.updateModelLabel(modelLabel);

  const modelArrow = document.createElement('span');
  modelArrow.className = 'ai-side-model-arrow';
  modelArrow.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="2 3 4 5 6 3"/></svg>`;

  const modelDropdown = document.createElement('div');
  modelDropdown.className = 'ai-side-model-dropdown styled-scrollbar';
  modelDropdown.style.display = 'none';
  callbacks.buildModelDropdown(modelDropdown, modelLabel);

  const modelTrigger = document.createElement('button');
  modelTrigger.type = 'button';
  modelTrigger.className = 'ai-side-model-trigger';
  modelTrigger.setAttribute('aria-expanded', 'false');
  modelTrigger.append(modelLabel, modelArrow);
  modelSelect.append(modelTrigger, modelDropdown);

  function closeModelDropdown(): void {
    modelDropdown.style.display = 'none';
    modelTrigger.setAttribute('aria-expanded', 'false');
  }

  modelTrigger.addEventListener('click', () => {
    const isOpen = modelDropdown.style.display !== 'none';
    if (isOpen) {
      closeModelDropdown();
    } else {
      callbacks.buildModelDropdown(modelDropdown, modelLabel);
      modelDropdown.style.display = '';
      modelTrigger.setAttribute('aria-expanded', 'true');
    }
  });
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Node) || !modelSelect.contains(event.target)) closeModelDropdown();
  });

  modelSelect.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && !modelSelect.contains(event.relatedTarget)) closeModelDropdown();
  });
  modelSelect.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || modelDropdown.style.display === 'none') return;
    event.stopPropagation();
    closeModelDropdown();
    modelTrigger.focus();
  });

  const thinkingToggle = callbacks.createThinkingToggle();

  // Layout toggle button (switch back to bottom mode)
  const layoutBtn = document.createElement('button');
  layoutBtn.className = 'ai-side-btn ai-side-btn-layout';
  layoutBtn.title = t('aiLayoutBottom');
  layoutBtn.innerHTML = SVG_LAYOUT_BOTTOM;
  layoutBtn.addEventListener('click', () => {
    callbacks.toggleLayout(callbacks.resolveCurrentInstance(instance));
  });

  // Attach image button — same UX as the bottom-mode AI Bar attach
  // button: left click opens a file picker (after first trying the
  // clipboard fallback for the system pasteboard); right click only
  // tries the clipboard.
  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'ai-side-btn ai-side-btn-attach ai-side-composer-action';
  attachBtn.title = t('aiAttachBtnTitle');
  attachBtn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>';
  attachBtn.append(t('aiSideAttach'));
  attachBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const m = await import('./ai-capsule-image-attach');
    const target = callbacks.resolveCurrentInstance(instance);
    const fromClipboard = await m.triggerClipboardImagePaste(target);
    if (fromClipboard) return;
    await m.pickAnyAttachmentFiles(target);
  });
  attachBtn.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const m = await import('./ai-capsule-image-attach');
    await m.triggerClipboardImagePaste(callbacks.resolveCurrentInstance(instance));
  });

  const textarea = document.createElement('textarea');
  textarea.className = 'ai-side-input';
  textarea.placeholder = t('aiSideQuestionPlaceholder');
  textarea.setAttribute('aria-label', textarea.placeholder);
  textarea.rows = 2;
  textarea.autocapitalize = 'off';
  textarea.setAttribute('autocorrect', 'off');
  textarea.spellcheck = false;

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'ai-side-btn ai-side-btn-send';
  updateSideSendButton(sendBtn, instance.isStreaming);

  // Wire up send — resolve the *current* instance each invocation
  // so the side panel (which lives at tab scope) always targets the
  // pane the user has focused at the moment they hit send, not the
  // pane that happened to create the side panel DOM.
  const doSend = () => {
    const text = textarea.value.trim();
    const target = callbacks.resolveCurrentInstance(instance);
    if (!callbacks.sendToLLM(target, text)) return;
    textarea.value = '';
    textarea.style.height = ''; // reset auto-height
    syncSideSendAvailability(target);
  };

  // Abort is handled by the agent's onAborted callback which calls
  // updateButtonHighlight → updateSideSendButton. We fire the
  // AbortController from run() plus the legacy agent.abort() for safety.
  sendBtn.addEventListener('click', () => {
    const target = callbacks.resolveCurrentInstance(instance);
    if (target.isStreaming) {
      target.agentAbort?.();
      target.agent.abort();
    } else {
      doSend();
    }
  });

  // ── IME composition tracking ──
  // Same logic as ai-capsule-input-setup.ts: track composition state
  // ourselves and add a small grace window after compositionend so a
  // trailing Enter (Chinese candidate confirmation) never submits.
  let imeActive = false;
  let imeJustEndedAt = 0;
  const IME_GRACE_MS = 80;
  textarea.addEventListener('compositionstart', () => { imeActive = true; });
  textarea.addEventListener('compositionupdate', () => { imeActive = true; });
  textarea.addEventListener('compositionend', () => {
    imeActive = false;
    imeJustEndedAt = Date.now();
  });
  const isImeKeydown = (e: KeyboardEvent): boolean => {
    if (imeActive) return true;
    if (e.isComposing) return true;
    if (e.keyCode === 229) return true;
    if (e.key === 'Enter' && (Date.now() - imeJustEndedAt) < IME_GRACE_MS) return true;
    return false;
  };

  // Keyboard: Enter=send, Shift+Enter=newline, Escape=abort
  textarea.addEventListener('keydown', (e) => {
    // IME guard — let the browser deliver the candidate, don't submit.
    if (isImeKeydown(e)) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      const target = callbacks.resolveCurrentInstance(instance);
      if (target.isStreaming) {
        target.agentAbort?.();
        target.agent.abort();
      }
    }
  });

  // Auto-resize textarea
  textarea.addEventListener('input', () => {
    textarea.style.height = '';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    syncSideSendAvailability(callbacks.resolveCurrentInstance(instance));
  });

  // Bottom bar: tools on left, send on right
  toolbar.append(attachBtn, modelSelect, thinkingToggle, layoutBtn, sendBtn);
  const followup = document.createElement('div');
  followup.className = 'ai-composer-followup';
  followup.textContent = t('aiSideFollowup');
  area.append(followup, textarea, toolbar);

  // Store references
  instance.sideInputArea = area;
  instance.sideInput = textarea;
  syncSideSendAvailability(instance);

  // Register this side input area as paste-eligible so the
  // document-level paste listener can route image clipboard data
  // to this instance.
  void import('./ai-capsule-image-attach').then(({ registerSidePanelForPaste }) => {
    registerSidePanelForPaste(instance, area);
  });

  return area;
}

/** Keep the side panel action label and icon in sync with the stream. */
export function updateSideSendButton(btn: HTMLButtonElement | null, isStreaming: boolean): void {
  if (!btn) return;
  const label = t(isStreaming ? 'aiStopGenerating' : 'aiSideSend');
  btn.classList.toggle('streaming-active', isStreaming);
  if (isStreaming) btn.disabled = false;
  btn.innerHTML = isStreaming ? stopIcon(16) : LLM_SEND_SVG;
  btn.setAttribute('aria-label', label);
  btn.title = isStreaming ? label : `${label} (Enter)`;
}

/** Get the side send button from instance */
export function getSideSendButton(instance: AICapsuleInstance): HTMLButtonElement | null {
  return instance.sideInputArea?.querySelector('.ai-side-btn-send') as HTMLButtonElement | null;
}

export function syncSideSendAvailability(instance: AICapsuleInstance): void {
  const button = getSideSendButton(instance);
  if (!button) return;
  button.disabled = !instance.isStreaming
    && !instance.sideInput?.value.trim()
    && instance.pendingImages.length === 0
    && instance.pendingAttachments.length === 0;
}

// ── Mode switching ──

/**
 * Switch to side panel mode.
 * Moves chatPanel into the side panel, adds ai-bar--side-active to AI Bar.
 * AI Bar stays in #terminal-panel.
 */
export function switchToSideMode(instance: AICapsuleInstance, callbacks: SideInputCallbacks): void {
  const mainContent = document.getElementById('main-content');
  if (!mainContent) return;

  // Create side panel elements if needed
  if (!instance.sidePanel || !instance.sideResizeHandle) {
    const { panel, handle } = createSidePanel();
    instance.sidePanel = panel;
    instance.sideResizeHandle = handle;
    setupSideResize(handle, panel);
  }

  // Restore saved width
  sideWidth = getSavedSideWidth();
  const { min, max } = getSidePanelBounds();
  sideWidth = Math.max(min, Math.min(max, sideWidth));
  instance.sidePanel.style.width = `${sideWidth}px`;

  // Create side input area if needed (before inserting chatPanel to control order)
  if (!instance.sideInputArea) {
    createSideInputArea(instance, callbacks);
  }

  // Ensure correct DOM order: chatPanel first, then sideInputArea
  // Always re-append to guarantee order even after mode switches
  if (instance.chatPanel) {
    const board = instance.chatPanel.querySelector(':scope > .ai-todo-board');
    const messages = instance.chatPanel.querySelector(':scope > .ai-chat-messages');
    if (board && messages) instance.chatPanel.insertBefore(board, messages);
    const targetRow = instance.chatPanel.querySelector('.ai-chat-target-row');
    const toolbar = instance.sideInputArea?.querySelector('.ai-side-input-toolbar');
    const permission = targetRow?.querySelector('.ai-side-trust-switcher');
    if (targetRow && permission && toolbar) {
      toolbar.querySelector('.ai-side-btn-attach')?.after(permission);
      instance.sideInputArea?.prepend(targetRow);
    }
    instance.chatPanel.classList.add('ai-chat-panel--side');
    instance.sidePanel.appendChild(instance.chatPanel);
  }
  if (instance.sideInputArea) {
    instance.sidePanel.appendChild(instance.sideInputArea);
  }

  // Add class to AI Bar to hide agent buttons (bar stays in terminal-panel)
  instance.element.classList.add('ai-bar--side-active');

  // Insert into #main-content (before JumpServer panel if exists)
  const jsHandle = mainContent.querySelector('.js-panel-resize-handle');
  if (jsHandle) {
    if (instance.sideResizeHandle.parentElement !== mainContent) {
      mainContent.insertBefore(instance.sideResizeHandle, jsHandle);
    }
    if (instance.sidePanel.parentElement !== mainContent) {
      mainContent.insertBefore(instance.sidePanel, jsHandle);
    }
  } else {
    if (instance.sideResizeHandle.parentElement !== mainContent) {
      mainContent.appendChild(instance.sideResizeHandle);
    }
    if (instance.sidePanel.parentElement !== mainContent) {
      mainContent.appendChild(instance.sidePanel);
    }
  }

  instance.sideResizeHandle.style.display = '';
  instance.sidePanel.style.display = '';
  instance.layoutMode = 'side';
  saveLayoutMode('side');

  // Re-render any pending images so they move from the AI bar
  // chip strip into the side panel thumbnail strip (or vice
  // versa). renderPendingStrip's container picker is layoutMode-
  // aware, so calling it after the mode flips is enough.
  void import('./ai-capsule-image-attach').then(({ renderPendingStrip }) => {
    renderPendingStrip(instance);
  });

  TerminalRegistry.resizeAll();
}

/**
 * Switch back to bottom mode.
 * Moves chatPanel back to #terminal-panel, removes ai-bar--side-active.
 */
export function switchToBottomMode(instance: AICapsuleInstance): void {
  const terminalPanel = document.getElementById('terminal-panel');
  if (!terminalPanel) return;

  // Move chat panel back to terminal-panel (before AI bar)
  if (instance.chatPanel) {
    const board = instance.chatPanel.querySelector(':scope > .ai-todo-board');
    if (board) instance.chatPanel.appendChild(board);
    const targetRow = instance.sideInputArea?.querySelector('.ai-chat-target-row');
    const permission = instance.sideInputArea?.querySelector('.ai-side-trust-switcher');
    if (targetRow && permission) {
      targetRow.append(permission);
      instance.chatPanel.insertBefore(targetRow, instance.chatPanel.querySelector('.ai-chat-run-status'));
    }
    instance.chatPanel.classList.remove('ai-chat-panel--side');
    terminalPanel.insertBefore(instance.chatPanel, instance.element);
    instance.chatPanel.style.height = '';
    instance.chatPanel.style.flex = '';
  }

  // Remove side-active class from AI Bar (restore all buttons)
  instance.element.classList.remove('ai-bar--side-active');

  // Hide side panel and resize handle
  if (instance.sidePanel) instance.sidePanel.style.display = 'none';
  if (instance.sideResizeHandle) instance.sideResizeHandle.style.display = 'none';

  instance.layoutMode = 'bottom';
  saveLayoutMode('bottom');

  // Re-render pending images into the AI bar chip strip.
  void import('./ai-capsule-image-attach').then(({ renderPendingStrip }) => {
    renderPendingStrip(instance);
  });

  TerminalRegistry.resizeAll();
}

/** Hide the side panel (chat closed/minimized). AI Bar not affected. */
export function hideSidePanel(instance: AICapsuleInstance): void {
  if (instance.sidePanel) instance.sidePanel.style.display = 'none';
  if (instance.sideResizeHandle) instance.sideResizeHandle.style.display = 'none';
  TerminalRegistry.resizeAll();
}

/** Show the side panel (chat opened). AI Bar not affected. */
export function showSidePanel(instance: AICapsuleInstance): void {
  if (instance.sidePanel) {
    sideWidth = getSavedSideWidth();
    const { min, max } = getSidePanelBounds();
    sideWidth = Math.max(min, Math.min(max, sideWidth));
    instance.sidePanel.style.width = `${sideWidth}px`;
    instance.sidePanel.style.display = '';
  }
  if (instance.sideResizeHandle) instance.sideResizeHandle.style.display = '';
  TerminalRegistry.resizeAll();
}
