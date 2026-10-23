/**
 * snippets.ts — Command snippet palette (Cmd/Ctrl+Shift+S).
 *
 * Snippets are kept in settings (`commandSnippets`) and edited under
 * Settings › Terminal › Snippets. The palette sends one to the focused pane
 * through the normal input path, so a tab with broadcast on sends it to every
 * pane.
 */

import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { loadSettings, type CommandSnippet } from './themes';
import { openSettings } from './view-manager';
import { escapeHtml } from './status-bar';
import { t } from './i18n';
import { isMacPlatform } from './app-state';

const PALETTE_ID = 'snippet-palette';

export function closeSnippetPalette(): void {
  document.getElementById(PALETTE_ID)?.remove();
}

function sendSnippet(sessionId: string, snippet: CommandSnippet, insertOnly: boolean): void {
  TerminalRegistry.typeIntoSession(sessionId, snippet.command, snippet.run && !insertOnly);
}

function matches(snippet: CommandSnippet, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return snippet.name.toLowerCase().includes(q) || snippet.command.toLowerCase().includes(q);
}

export function openSnippetPalette(): void {
  const sessionId = TabManager.getActiveSessionId();
  if (!sessionId) return;
  const mt = TerminalRegistry.get(sessionId);
  if (!mt || mt.ended) return;
  closeSnippetPalette();

  const snippets = loadSettings().commandSnippets ?? [];
  const palette = document.createElement('div');
  palette.id = PALETTE_ID;
  palette.className = 'snippet-palette';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'snippet-palette-input';
  input.placeholder = t('snippetPaletteSearch');
  input.spellcheck = false;
  input.autocomplete = 'off';

  const list = document.createElement('div');
  list.className = 'snippet-palette-list';

  const footer = document.createElement('div');
  footer.className = 'snippet-palette-footer';
  const hintText = document.createElement('span');
  hintText.textContent = t(isMacPlatform ? 'snippetPaletteHintMac' : 'snippetPaletteHint');
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'snippet-palette-manage';
  manage.textContent = t('snippetManage');
  manage.addEventListener('mousedown', (e) => e.preventDefault());
  manage.addEventListener('click', () => {
    closeSnippetPalette();
    void openSettings('terminal');
  });
  footer.append(hintText, manage);

  palette.append(input, list, footer);
  document.body.appendChild(palette);

  let visible: CommandSnippet[] = [];
  let selected = 0;

  const choose = (snippet: CommandSnippet | undefined, insertOnly: boolean) => {
    if (!snippet) return;
    closeSnippetPalette();
    sendSnippet(sessionId, snippet, insertOnly);
  };

  const render = () => {
    visible = snippets.filter((s) => matches(s, input.value.trim()));
    if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
    list.innerHTML = '';
    if (snippets.length === 0) {
      list.innerHTML = `<div class="snippet-palette-empty">${escapeHtml(t('snippetEmpty'))}</div>`;
      return;
    }
    if (visible.length === 0) {
      list.innerHTML = `<div class="snippet-palette-empty">${escapeHtml(t('snippetNoMatch'))}</div>`;
      return;
    }
    visible.forEach((snippet, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `snippet-palette-item${i === selected ? ' selected' : ''}`;
      const firstLine = snippet.command.split('\n')[0];
      const more = snippet.command.includes('\n') ? ' …' : '';
      row.innerHTML =
        `<span class="snippet-palette-name">${escapeHtml(snippet.name || firstLine)}</span>` +
        `<span class="snippet-palette-command">${escapeHtml(firstLine + more)}</span>` +
        (snippet.run ? '' : `<span class="snippet-palette-tag">${escapeHtml(t('snippetInsertOnlyTag'))}</span>`);
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', (e) => choose(snippet, e.altKey));
      row.addEventListener('mousemove', () => {
        if (selected === i) return;
        selected = i;
        list.querySelectorAll('.snippet-palette-item').forEach((el, j) => el.classList.toggle('selected', j === i));
      });
      list.appendChild(row);
    });
    list.querySelector('.snippet-palette-item.selected')?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (visible.length) {
        selected = (selected + (e.key === 'ArrowDown' ? 1 : visible.length - 1)) % visible.length;
        render();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(visible[selected], e.altKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSnippetPalette();
      mt.terminal.focus();
    }
  });
  input.addEventListener('blur', () => {
    // Clicking elsewhere closes the palette; a click inside keeps focus.
    setTimeout(() => {
      if (!palette.contains(document.activeElement)) closeSnippetPalette();
    }, 0);
  });

  render();
  input.focus();
}
