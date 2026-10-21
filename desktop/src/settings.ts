import { AppSettings, updateSettings } from './themes';
import { createOverlayScrollbar } from './overlay-scrollbar';
import { t } from './i18n';
import { createGeneralPages } from './settings-general';
import { createAITab } from './settings-ai';
import { createAboutTab } from './settings-about';
import { SETTINGS_ICONS, type SettingsPage } from './settings-layout';

export interface SettingsPanelOptions {
  settings: AppSettings;
  initialTab?: string;
  onSettingsChange: (settings: AppSettings) => void;
  onLanguageChange: () => void;
}

/** Old tab names that links or callers may still pass. */
const LEGACY_TABS: Record<string, string> = { general: 'appearance' };

export function createSettingsPanel(options: SettingsPanelOptions): HTMLDivElement {
  const { onSettingsChange, onLanguageChange } = options;
  let current = { ...options.settings };

  // Only the current edit may override freshly persisted values. Replaying all
  // earlier edits would overwrite later changes from another settings window.
  //
  // The panel used to persist `{ ...snapshot, ...patch }`, where `snapshot` was
  // the whole settings object captured when the panel was created. Every change
  // made here therefore rewrote the entire settings object from that stale copy,
  // silently rolling back anything another window had written in the meantime —
  // most visibly the main window's remembered size/position, which made the app
  // "forget" its window frame and reopen at the default one.
  function update(patch: Partial<AppSettings>): void {
    current = updateSettings(patch);
    onSettingsChange(current);
  }

  const panel = document.createElement('div');
  panel.className = 'settings-panel settings-panel-window settings-panel-sidebar';

  const pages: SettingsPage[] = [
    ...createGeneralPages(current, update, onLanguageChange),
    { key: 'ai', label: t('settingsTabAI'), icon: SETTINGS_ICONS.ai, el: wrapPage(t('settingsTabAI'), createAITab(current, update)), searchable: false },
    { key: 'about', label: t('settingsTabAbout'), icon: SETTINGS_ICONS.about, el: wrapPage(null, createAboutTab()), searchable: false },
  ];

  // --- Sidebar ---
  const sidebar = document.createElement('nav');
  sidebar.className = 'settings-sidebar';

  const search = document.createElement('input');
  search.type = 'search';
  search.id = 'settings-search';
  search.className = 'settings-search';
  search.placeholder = t('settingsSearchPlaceholder');
  search.setAttribute('aria-label', t('settingsSearchPlaceholder'));
  search.spellcheck = false;
  sidebar.appendChild(search);

  const navButtons: HTMLButtonElement[] = [];
  for (const page of pages) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-nav-item';
    btn.dataset.tab = page.key;
    btn.innerHTML = `<span class="settings-nav-icon">${page.icon}</span><span class="settings-nav-label"></span>`;
    btn.querySelector('.settings-nav-label')!.textContent = page.label;
    sidebar.appendChild(btn);
    navButtons.push(btn);

    page.el.classList.add('settings-tab-content');
    page.el.dataset.tab = page.key;
  }
  panel.appendChild(sidebar);

  // --- Content ---
  const contentWrapper = document.createElement('div');
  contentWrapper.className = 'settings-content';
  for (const page of pages) contentWrapper.appendChild(page.el);
  const noResults = document.createElement('div');
  noResults.className = 'settings-search-empty';
  noResults.textContent = t('settingsSearchNoResults');
  noResults.hidden = true;
  contentWrapper.appendChild(noResults);
  createOverlayScrollbar({ viewport: contentWrapper, container: contentWrapper });
  panel.appendChild(contentWrapper);

  let activeKey = pages[0].key;
  function activateTab(key: string): void {
    activeKey = key;
    if (search.value) { search.value = ''; applySearch(); }
    navButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    for (const page of pages) {
      const on = page.key === key;
      page.el.classList.toggle('active', on);
      if (on) page.el.dispatchEvent(new Event('tab-activated'));
    }
    contentWrapper.scrollTop = 0;
  }

  sidebar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.settings-nav-item');
    if (btn?.dataset.tab) activateTab(btn.dataset.tab);
  });

  // Search filters the card rows of every page at once. AI and About are not
  // laid out as rows, so they only show up when their own name matches.
  function applySearch(): void {
    const q = search.value.trim().toLowerCase();
    panel.classList.toggle('settings-searching', !!q);
    let anyShown = false;
    for (const page of pages) {
      const pageHit = !!q && page.label.toLowerCase().includes(q);
      let pageShown = false;
      for (const group of page.el.querySelectorAll<HTMLElement>('.settings-group')) {
        const groupHit = pageHit || (!!q && (group.querySelector('.settings-group-title')?.textContent ?? '').toLowerCase().includes(q));
        let groupShown = false;
        for (const row of group.querySelectorAll<HTMLElement>('.settings-card > *')) {
          const hit = !q || groupHit || (row.textContent ?? '').toLowerCase().includes(q);
          row.classList.toggle('settings-search-miss', !hit);
          if (hit && row.style.display !== 'none') groupShown = true;
        }
        group.classList.toggle('settings-search-miss', !groupShown);
        pageShown ||= groupShown;
      }
      if (!page.searchable) pageShown = pageHit;
      page.el.classList.toggle('settings-search-hit', !!q && pageShown);
      anyShown ||= pageShown;
    }
    navButtons.forEach((b) => b.classList.toggle('active', !q && b.dataset.tab === activeKey));
    noResults.hidden = !q || anyShown;
    contentWrapper.scrollTop = 0;
  }
  search.addEventListener('input', applySearch);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; applySearch(); }
  });

  const wanted = options.initialTab ? (LEGACY_TABS[options.initialTab] ?? options.initialTab) : '';
  activateTab(pages.some((p) => p.key === wanted) ? wanted : pages[0].key);

  return panel;
}

function wrapPage(title: string | null, body: HTMLElement): HTMLElement {
  const page = document.createElement('div');
  page.className = 'settings-page';
  if (title) {
    const h = document.createElement('h2');
    h.className = 'settings-page-title';
    h.textContent = title;
    page.appendChild(h);
  }
  page.appendChild(body);
  return page;
}
