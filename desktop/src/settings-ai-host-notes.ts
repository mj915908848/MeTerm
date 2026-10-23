// ─── Settings › AI › Host Notes ────────────────────────────────
// Read, edit and delete the per-host notes the agent saves with
// save_host_note (see ai-host-notes.ts). The notes live outside
// AppSettings, so edits save straight to their own store.

import { t } from './i18n';
import { listHostNotes, LOCAL_HOST_KEY, setHostNotes, HOST_NOTES_MAX_CHARS } from './ai-host-notes';
import { settingLabel } from './settings-ai-permission';

export function createHostNotesRows(): HTMLElement[] {
  const container = document.createElement('div');
  container.className = 'ai-host-notes';
  container.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

  function render(): void {
    container.innerHTML = '';
    const entries = listHostNotes();
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-hint';
      empty.style.cssText = 'font-size:11px;opacity:0.7;padding:6px 0;';
      empty.textContent = t('aiHostNotesNone');
      container.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const block = document.createElement('div');
      block.className = 'settings-section ai-host-notes-entry';
      block.style.cssText = 'flex-direction:column;align-items:stretch;gap:6px;';

      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
      head.appendChild(settingLabel(entry.key === LOCAL_HOST_KEY ? t('aiHostNotesLocal') : entry.key, t('aiHostNotesHint')));
      const del = document.createElement('button');
      del.className = 'settings-select settings-test-btn';
      del.textContent = t('aiHostNotesDelete');
      del.onclick = () => {
        setHostNotes(entry.key, '');
        render();
      };
      head.appendChild(del);

      const area = document.createElement('textarea');
      area.className = 'settings-input';
      area.rows = Math.min(10, Math.max(3, entry.notes.split('\n').length + 1));
      area.maxLength = HOST_NOTES_MAX_CHARS;
      area.spellcheck = false;
      area.value = entry.notes;
      area.style.cssText = 'width:100%;box-sizing:border-box;resize:vertical;font-family:var(--font-mono, monospace);font-size:12px;line-height:1.5;';
      for (const type of ['keydown', 'keyup', 'keypress'] as const) {
        area.addEventListener(type, (e) => e.stopPropagation());
      }
      area.addEventListener('change', () => {
        if (area.value.trim() === entry.notes) return;
        setHostNotes(entry.key, area.value);
        if (!area.value.trim()) render();
      });

      block.append(head, area);
      container.appendChild(block);
    }
  }

  render();
  // Another window (the agent saving a note) may change the store.
  const onStorage = (e: StorageEvent) => {
    // The page is rebuilt on every settings change; drop stale listeners.
    if (!container.isConnected) {
      window.removeEventListener('storage', onStorage);
      return;
    }
    if (e.key === 'meterm-host-notes' && !container.contains(document.activeElement)) render();
  };
  window.addEventListener('storage', onStorage);
  return [container];
}
