/**
 * terminal-search.ts — Find in the terminal buffer (Cmd+F / Ctrl+Shift+F).
 *
 * A small bar in the top-right corner of the pane. The search addon is loaded
 * the first time a terminal is searched, so terminals that are never searched
 * pay nothing for it.
 */

import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import { TerminalRegistry } from './terminal';
import { t, tf } from './i18n';

const addons = new WeakMap<Terminal, SearchAddon>();

// Decoration colors must be #RRGGBB. Amber reads on both dark and light themes.
const DECORATIONS: ISearchOptions['decorations'] = {
  matchBackground: '#7a5c10',
  matchBorder: '#d4a017',
  matchOverviewRuler: '#d4a017',
  activeMatchBackground: '#d97706',
  activeMatchBorder: '#ffb020',
  activeMatchColorOverviewRuler: '#ff8c00',
};

interface SearchBar {
  el: HTMLElement;
  input: HTMLInputElement;
  focus(): void;
}

const bars = new WeakMap<HTMLElement, SearchBar>();

function addonFor(terminal: Terminal): SearchAddon {
  let addon = addons.get(terminal);
  if (!addon) {
    addon = new SearchAddon({ highlightLimit: 2000 });
    terminal.loadAddon(addon);
    addons.set(terminal, addon);
  }
  return addon;
}

function iconButton(className: string, title: string, svg: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `terminal-search-btn ${className}`;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = svg;
  // Keep focus in the input so typing continues after a click.
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  return btn;
}

function createBar(container: HTMLElement, terminal: Terminal): SearchBar {
  const addon = addonFor(terminal);
  let caseSensitive = false;
  let regex = false;

  const el = document.createElement('div');
  el.className = 'terminal-search-bar';
  el.addEventListener('mousedown', (e) => e.stopPropagation());

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'terminal-search-input';
  input.placeholder = t('terminalSearchPlaceholder');
  input.spellcheck = false;
  input.autocomplete = 'off';

  const count = document.createElement('span');
  count.className = 'terminal-search-count';

  const caseBtn = iconButton('terminal-search-toggle', t('terminalSearchCase'), '<span>Aa</span>');
  const regexBtn = iconButton('terminal-search-toggle', t('terminalSearchRegex'), '<span>.*</span>');
  const prevBtn = iconButton('', t('terminalSearchPrev'),
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>');
  const nextBtn = iconButton('', t('terminalSearchNext'),
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>');
  const closeBtn = iconButton('', t('terminalSearchClose'),
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>');

  el.append(input, count, caseBtn, regexBtn, prevBtn, nextBtn, closeBtn);
  container.appendChild(el);

  const options = (incremental: boolean): ISearchOptions => ({
    caseSensitive, regex, incremental, decorations: DECORATIONS,
  });

  const showCount = (index: number, total: number) => {
    if (!input.value) {
      count.textContent = '';
      el.classList.remove('no-results');
    } else if (total === 0) {
      count.textContent = t('terminalSearchNoResults');
      el.classList.add('no-results');
    } else {
      // resultIndex is -1 when there are more matches than the highlight limit.
      count.textContent = index >= 0
        ? tf('terminalSearchCount', { index: index + 1, total })
        : tf('terminalSearchCountMany', { total });
      el.classList.remove('no-results');
    }
  };
  const resultsSub = addon.onDidChangeResults(({ resultIndex, resultCount }) => showCount(resultIndex, resultCount));

  const run = (direction: 'next' | 'prev', incremental = false) => {
    const term = input.value;
    if (!term) {
      addon.clearDecorations();
      terminal.clearSelection();
      showCount(-1, 0);
      return;
    }
    if (regex) {
      try { new RegExp(term); } catch { showCount(-1, 0); return; }
    }
    if (direction === 'next') addon.findNext(term, options(incremental));
    else addon.findPrevious(term, options(false));
  };

  const close = () => {
    resultsSub.dispose();
    addon.clearDecorations();
    terminal.clearSelection();
    el.remove();
    bars.delete(container);
    terminal.focus();
  };

  input.addEventListener('input', () => run('next', true));
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      run(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  caseBtn.addEventListener('click', () => {
    caseSensitive = !caseSensitive;
    caseBtn.classList.toggle('active', caseSensitive);
    run('next', true);
  });
  regexBtn.addEventListener('click', () => {
    regex = !regex;
    regexBtn.classList.toggle('active', regex);
    run('next', true);
  });
  prevBtn.addEventListener('click', () => run('prev'));
  nextBtn.addEventListener('click', () => run('next'));
  closeBtn.addEventListener('click', close);

  return {
    el,
    input,
    focus() {
      input.focus();
      input.select();
    },
  };
}

/** Open (or refocus) the find bar on a session's terminal. */
export function openTerminalSearch(sessionId: string): void {
  const mt = TerminalRegistry.get(sessionId);
  if (!mt || !mt.container.isConnected) return;
  let bar = bars.get(mt.container);
  const selection = mt.terminal.hasSelection() ? mt.terminal.getSelection() : '';
  if (!bar) {
    bar = createBar(mt.container, mt.terminal);
    bars.set(mt.container, bar);
  }
  // Start from a one-line selection, like most editors do.
  if (selection && !selection.includes('\n') && selection.length <= 200) {
    bar.input.value = selection;
    bar.input.dispatchEvent(new Event('input'));
  }
  bar.focus();
}
