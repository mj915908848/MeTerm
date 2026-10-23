// ─── Host notes: AI panel toolbar entry ────────────────────────
// A toolbar button in the AI side panel that opens a popover editing
// the notes of the host the focused pane is connected to. A dot on the
// button shows that host already has notes.

import { t, tf } from './i18n';
import { DrawerManager } from './drawer';
import {
  getHostNotes,
  HOST_NOTES_CHANGED_EVENT,
  HOST_NOTES_STORAGE_KEY,
  hostNotesKey,
} from './ai-host-notes';
import { hostNotesTitle } from './ai-host-notes-labels';
import { createHostNotesEditor } from './ai-host-notes-editor';

const NOTES_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2h9a1 1 0 011 1v7.5L10 14H3.5a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M10 14v-2.5a1 1 0 011-1h2.5"/><line x1="5" y1="5.5" x2="11" y2="5.5"/><line x1="5" y1="8" x2="9" y2="8"/></svg>`;

/** Notes key of the host behind a terminal session ("local" for local panes). */
export function hostNotesKeyForSession(sessionId: string): string | null {
  const info = DrawerManager.getServerInfo(sessionId);
  return info ? hostNotesKey(true, `${info.username}@${info.host}:${info.port}`) : hostNotesKey(false, null);
}

/**
 * "Loaded N host notes for X" for the start of a conversation, so the
 * user can see that the agent knows about this host. Null when the
 * host has no notes.
 */
export function hostNotesLoadedNotice(sessionId: string): string | null {
  const key = hostNotesKeyForSession(sessionId);
  if (!key) return null;
  const count = getHostNotes(key).split('\n').filter((l) => l.trim()).length;
  if (count === 0) return null;
  return tf('aiHostNotesLoaded', { count, host: hostNotesTitle(key).title });
}

/**
 * Toolbar button for the AI side panel. `currentSessionId` is read on
 * every click so the popover follows whichever pane has focus.
 */
export function createHostNotesButton(currentSessionId: () => string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'ai-side-btn ai-side-btn-host-notes';
  btn.title = t('aiHostNotesBtnTitle');
  btn.innerHTML = NOTES_ICON_SVG;

  let popover: HTMLDivElement | null = null;
  let editor: (HTMLDivElement & { save: () => void }) | null = null;

  const refreshDot = () => {
    const key = hostNotesKeyForSession(currentSessionId());
    btn.classList.toggle('has-notes', !!key && !!getHostNotes(key));
  };

  const close = () => {
    editor?.save();
    popover?.remove();
    popover = null;
    editor = null;
    btn.classList.remove('active');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    refreshDot();
  };
  const onOutside = (e: MouseEvent) => {
    const target = e.target as Node;
    if (popover?.contains(target) || btn.contains(target)) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && popover) {
      e.stopPropagation();
      close();
    }
  };

  const open = () => {
    const anchor = (btn.closest('.ai-side-input-area') as HTMLElement | null) ?? btn;
    const rect = anchor.getBoundingClientRect();
    popover = document.createElement('div');
    popover.className = 'ai-host-notes-popover';
    popover.style.left = `${Math.max(8, rect.left)}px`;
    popover.style.width = `${Math.max(260, rect.width)}px`;
    popover.style.bottom = `${window.innerHeight - rect.top + 6}px`;

    const head = document.createElement('div');
    head.className = 'ai-host-notes-popover-head';
    const label = document.createElement('div');
    label.className = 'ai-host-notes-popover-label';
    const key = hostNotesKeyForSession(currentSessionId());
    if (key) {
      const { title, subtitle } = hostNotesTitle(key);
      const strong = document.createElement('span');
      strong.className = 'ai-host-notes-title';
      strong.textContent = `${t('aiHostNotesBtnTitle')} · ${title}`;
      label.appendChild(strong);
      if (subtitle) {
        const sub = document.createElement('span');
        sub.className = 'ai-host-notes-subtitle';
        sub.textContent = subtitle;
        label.appendChild(sub);
      }
    } else {
      label.textContent = t('aiHostNotesBtnTitle');
    }
    const manage = document.createElement('button');
    manage.className = 'ai-host-notes-link';
    manage.textContent = t('aiHostNotesManage');
    manage.onclick = () => {
      close();
      void import('./view-manager').then((m) => m.openSettings('ai'));
    };
    head.append(label, manage);
    popover.appendChild(head);

    if (key) {
      editor = createHostNotesEditor(key, { maxHeight: Math.max(120, rect.top - 120), autofocus: true });
      popover.appendChild(editor);
    } else {
      const empty = document.createElement('div');
      empty.className = 'ai-host-notes-intro';
      empty.textContent = t('aiHostNotesNoHost');
      popover.appendChild(empty);
    }

    document.body.appendChild(popover);
    btn.classList.add('active');
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popover) close();
    else open();
  });
  btn.addEventListener('mouseenter', refreshDot);
  const onChange = (e: Event) => {
    if (!btn.isConnected) {
      window.removeEventListener('storage', onChange);
      window.removeEventListener(HOST_NOTES_CHANGED_EVENT, onChange);
      return;
    }
    if (e instanceof StorageEvent && e.key !== HOST_NOTES_STORAGE_KEY) return;
    refreshDot();
  };
  window.addEventListener('storage', onChange);
  window.addEventListener(HOST_NOTES_CHANGED_EVENT, onChange);
  requestAnimationFrame(refreshDot);
  return btn;
}
