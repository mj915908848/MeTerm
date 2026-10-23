// ─── Host notes: editor ────────────────────────────────────────
// Textarea bound to one host's notes: grows with its text, shows a
// character count and saves when it loses focus. Used by Settings › AI ›
// Host Notes and by the AI panel popover (ai-host-notes-popover.ts).
// Kept free of terminal/drawer imports so the settings window can load it.

import { t } from './i18n';
import { getHostNotes, HOST_NOTES_MAX_CHARS, setHostNotes } from './ai-host-notes';

/**
 * Textarea bound to one host's notes. Saves on blur (and through the
 * returned element's `save()`), so closing the popover or leaving the
 * settings page never loses an edit.
 */
export function createHostNotesEditor(
  key: string,
  opts: { maxHeight: number; onCleared?: () => void; autofocus?: boolean },
): HTMLDivElement & { save: () => void } {
  const wrap = document.createElement('div') as HTMLDivElement & { save: () => void };
  wrap.className = 'ai-host-notes-editor';

  const area = document.createElement('textarea');
  area.className = 'ai-host-notes-textarea';
  area.maxLength = HOST_NOTES_MAX_CHARS;
  area.spellcheck = false;
  area.placeholder = t('aiHostNotesPlaceholder');
  area.value = getHostNotes(key);
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    area.addEventListener(type, (e) => {
      if (type === 'keydown' && (e as KeyboardEvent).key === 'Escape') return; // let the popover close
      e.stopPropagation();
    });
  }

  const count = document.createElement('div');
  count.className = 'ai-host-notes-count';

  const fit = () => {
    area.style.height = 'auto';
    area.style.height = `${Math.min(opts.maxHeight, Math.max(56, area.scrollHeight + 2))}px`;
    count.textContent = `${area.value.length} / ${HOST_NOTES_MAX_CHARS}`;
  };
  area.addEventListener('input', fit);

  let saved = area.value.trim();
  wrap.save = () => {
    const next = area.value.trim();
    if (next === saved) return;
    setHostNotes(key, area.value);
    saved = next;
    if (!next) opts.onCleared?.();
  };
  area.addEventListener('blur', () => wrap.save());

  wrap.append(area, count);
  requestAnimationFrame(() => {
    fit();
    if (opts.autofocus) {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    }
  });
  return wrap;
}
