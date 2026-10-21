/**
 * Building blocks for the settings window: a page per sidebar category, made
 * of titled groups whose rows sit in one card.
 */

export interface SettingsPage {
  key: string;
  label: string;
  icon: string;
  el: HTMLElement;
  /** Pages whose content is not made of card rows are left out of search. */
  searchable: boolean;
}

const svg = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const SETTINGS_ICONS = {
  appearance: svg('<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor" stroke="none"/>'),
  terminal: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3.5"/>'),
  files: svg('<path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5h6.3a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>'),
  window: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M1.5 5.5h13M4 4h.01M6 4h.01"/>'),
  connections: svg('<path d="M6.5 9.5 9.5 6.5"/><path d="M7.5 4.5 9 3a2.5 2.5 0 0 1 3.5 3.5L11 8M8.5 11.5 7 13a2.5 2.5 0 0 1-3.5-3.5L5 8"/>'),
  ai: svg('<path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6z"/>'),
  about: svg('<circle cx="8" cy="8" r="6.5"/><path d="M8 7.2V11M8 5h.01"/>'),
};

/** A titled group of rows. Missing rows are skipped. */
export function createGroup(title: string | null, rows: Array<HTMLElement | null | undefined>): HTMLElement {
  const group = document.createElement('section');
  group.className = 'settings-group';
  if (title) {
    const h = document.createElement('h3');
    h.className = 'settings-group-title';
    h.textContent = title;
    group.appendChild(h);
  }
  const card = document.createElement('div');
  card.className = 'settings-card';
  for (const row of rows) if (row) card.appendChild(row);
  group.appendChild(card);
  return group;
}

export function createPage(title: string, groups: HTMLElement[]): HTMLElement {
  const page = document.createElement('div');
  page.className = 'settings-page';
  const h = document.createElement('h2');
  h.className = 'settings-page-title';
  h.textContent = title;
  page.appendChild(h);
  for (const g of groups) page.appendChild(g);
  return page;
}

/**
 * Turn a `<label><input type=checkbox> Text</label>` from an older checkbox
 * group into a card row with the text first and the switch at the end. The
 * input element itself is kept, so its handlers keep working.
 */
export function switchRow(input: HTMLInputElement | null): HTMLElement | null {
  const label = input?.closest('label');
  if (!input || !label) return null;
  const text = document.createElement('span');
  text.className = 'settings-switch-text';
  text.textContent = (label.textContent ?? '').trim();
  label.textContent = '';
  label.className = 'settings-switch-row';
  label.append(text, input);
  return label;
}
