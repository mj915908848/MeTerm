// ─── Settings › AI › Host Notes ────────────────────────────────
// Read, edit and delete the per-host notes the agent saves with
// save_host_note (see ai-host-notes.ts). The notes live outside
// AppSettings, so edits save straight to their own store. The same
// notes can be edited for the current host from the AI panel toolbar
// (ai-host-notes-popover.ts); both use ai-host-notes-editor.ts.

import { t, tf } from './i18n';
import { HOST_NOTES_STORAGE_KEY, listHostNotes, setHostNotes } from './ai-host-notes';
import { formatNotesTime, hostNotesTitle } from './ai-host-notes-labels';
import { createHostNotesEditor } from './ai-host-notes-editor';

export function createHostNotesRows(): HTMLElement[] {
  const container = document.createElement('div');
  container.className = 'ai-host-notes';

  function render(): void {
    container.innerHTML = '';
    const entries = listHostNotes();
    const intro = document.createElement('div');
    intro.className = 'ai-host-notes-intro';
    intro.textContent = entries.length === 0 ? t('aiHostNotesNone') : t('aiHostNotesHint');
    container.appendChild(intro);

    for (const entry of entries) {
      const block = document.createElement('div');
      block.className = 'ai-host-notes-entry';

      const head = document.createElement('div');
      head.className = 'ai-host-notes-head';
      const { title, subtitle } = hostNotesTitle(entry.key);
      const name = document.createElement('span');
      name.className = 'ai-host-notes-title';
      name.textContent = title;
      head.appendChild(name);
      if (subtitle) {
        const addr = document.createElement('span');
        addr.className = 'ai-host-notes-subtitle';
        addr.textContent = subtitle;
        head.appendChild(addr);
      }
      const spacer = document.createElement('span');
      spacer.style.flex = '1';
      head.appendChild(spacer);
      const time = document.createElement('span');
      time.className = 'ai-host-notes-time';
      time.textContent = entry.updatedAt ? tf('aiHostNotesUpdated', { time: formatNotesTime(entry.updatedAt) }) : '';
      head.appendChild(time);

      // Deleting cannot be undone: the first click arms, the second deletes.
      const del = document.createElement('button');
      del.className = 'ai-host-notes-delete';
      del.textContent = t('aiHostNotesDelete');
      let armTimer = 0;
      del.onclick = () => {
        if (del.classList.contains('armed')) {
          window.clearTimeout(armTimer);
          setHostNotes(entry.key, '');
          render();
          return;
        }
        del.classList.add('armed');
        del.textContent = t('aiHostNotesDeleteConfirm');
        armTimer = window.setTimeout(() => {
          del.classList.remove('armed');
          del.textContent = t('aiHostNotesDelete');
        }, 3000);
      };
      head.appendChild(del);

      const editor = createHostNotesEditor(entry.key, {
        maxHeight: 320,
        onCleared: render,
      });
      block.append(head, editor);
      container.appendChild(block);
    }
  }

  render();
  const onStorage = (e: StorageEvent) => {
    // The page is rebuilt on every settings change; drop stale listeners.
    if (!container.isConnected) {
      window.removeEventListener('storage', onStorage);
      return;
    }
    if (e.key === HOST_NOTES_STORAGE_KEY && !container.contains(document.activeElement)) render();
  };
  window.addEventListener('storage', onStorage);
  return [container];
}
