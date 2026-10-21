/**
 * home-dashboard.ts — the full-page home view.
 *
 * This page was removed in v0.2.11 ("取消独立主页"): the connection manager
 * became a docked left sidebar and the view itself was reduced to a minimal
 * empty-state card. That reasoning assumed the page was only ever seen when no
 * session was open — and startup opened a local session unconditionally, so the
 * page was almost never seen at all.
 *
 * Two things changed since. Startup now honours the "create a local session on
 * launch" setting (off by default), so the page IS the starting point again; and
 * the connection list moved off this page (now the connections drawer), freeing it to be
 * what it used to be. So the page is back, as the saved-connection table
 * (home-connection-manager.ts): search, "local terminal" and "+ new" in its
 * header, group filter chips, sortable columns and an inspector for the
 * selection; the footer sits below it.
 *
 * Division of labour, unchanged from v0.2.17: this page is the *no-session*
 * starting point, the connections drawer (connections-drawer.ts) is for looking
 * connections up while a terminal is open. Both read the same stores, so an edit
 * in one shows up in the other.
 */
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { t } from './i18n';
import { createConnectionManager, refreshConnectionManager } from './home-connection-manager';
import { renderSearchOverlay, hideSearchOverlay } from './home-dashboard-right';
import { createUnifiedSearch } from './home-dashboard-search';

// Re-export names kept for ssh.ts / view-manager backwards compat.
export { createDashboardHomeView as createSSHHomeView, updateDashboardHomeView as updateSSHHomeView };

const GITHUB_URL = 'https://github.com/paidaxingyo666/MeTerm';
const GITEE_URL = 'https://gitee.com/paidaxingy666/me-term';

const SEARCH_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>';

function createFooterLink(label: string, url: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = 'home-dash-footer-link';
  link.href = '#';
  link.textContent = label;
  link.onclick = (event) => {
    event.preventDefault();
    void openUrl(url);
  };
  return link;
}

export function createDashboardHomeView(): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'home-view home-dashboard';
  container.id = 'home-view';

  // ── Search bar (results land in the floating overlay below it) ──
  const searchRow = document.createElement('div');
  searchRow.className = 'home-dash-search-row';

  const searchWrap = document.createElement('div');
  searchWrap.className = 'home-dash-search-wrap';

  const searchIcon = document.createElement('span');
  searchIcon.className = 'home-dash-search-icon';
  searchIcon.innerHTML = SEARCH_ICON;

  const searchInput = document.createElement('input');
  searchInput.className = 'home-dash-search-input';
  searchInput.type = 'text';
  searchInput.placeholder = t('homeSearchPlaceholder');
  searchInput.id = 'home-search-input';

  const kbd = document.createElement('span');
  kbd.className = 'home-dash-search-kbd';
  kbd.textContent = '⌘K';

  searchWrap.appendChild(searchIcon);
  searchWrap.appendChild(searchInput);
  searchWrap.appendChild(kbd);
  searchRow.appendChild(searchWrap);

  const overlay = document.createElement('div');
  overlay.className = 'home-search-overlay';
  overlay.id = 'home-search-overlay';
  overlay.style.display = 'none';
  searchRow.appendChild(overlay);

  // ── Every saved connection, as a table; the search row sits in its header ──
  container.appendChild(createConnectionManager({ searchRow, searchInput }));

  // ── Footer (outside the scroll, pinned to the bottom) ──
  const footer = document.createElement('div');
  footer.className = 'home-dash-footer';

  const versionLabel = document.createElement('span');
  versionLabel.className = 'home-dash-footer-version';
  versionLabel.textContent = 'MeTerm';
  footer.appendChild(versionLabel);

  const footerLinks: ReadonlyArray<readonly [string, string]> = [
    ['GitHub', GITHUB_URL],
    ['Gitee', GITEE_URL],
    [t('aboutLicenses'), `${GITHUB_URL}/blob/main/THIRD_PARTY_LICENSES.md`],
  ];
  for (const [label, url] of footerLinks) {
    const sep = document.createElement('span');
    sep.className = 'home-dash-footer-sep';
    sep.textContent = '·';
    footer.appendChild(sep);
    footer.appendChild(createFooterLink(label, url));
  }
  container.appendChild(footer);

  // The bundled version is read asynchronously; until it lands the footer shows
  // the bare product name rather than a wrong number.
  void getVersion()
    .then((version) => {
      versionLabel.textContent = t('homeFooterVersion').replace('{version}', version);
    })
    .catch(() => {});

  // ── Search wiring ──
  const search = createUnifiedSearch({
    onLeftUpdate: () => {
      // Results live in the overlay only — the page behind it never filters.
    },
    onRightUpdate: (query: string) => renderSearchOverlay(overlay, query),
  });

  searchInput.addEventListener('input', () => {
    search.search(searchInput.value.trim());
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      searchInput.value = '';
      search.search('');
      searchInput.blur();
    }
  });

  const onDocumentMouseDown = (event: MouseEvent) => {
    if (overlay.style.display !== 'none' && !searchRow.contains(event.target as Node)) {
      hideSearchOverlay(overlay);
    }
  };
  document.addEventListener('mousedown', onDocumentMouseDown);

  // ⌘K / Ctrl+K focuses the search box — but only while the page is on screen
  // (offsetParent is null once the view is detached).
  const onKeydown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
      const input = document.getElementById('home-search-input') as HTMLInputElement | null;
      if (input && input.offsetParent !== null) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    }
  };
  document.addEventListener('keydown', onKeydown);

  // The view is created and destroyed on every home/terminal switch, so the
  // document-level listeners must go with it.
  const observer = new MutationObserver(() => {
    if (!document.getElementById('home-view')) {
      document.removeEventListener('mousedown', onDocumentMouseDown);
      document.removeEventListener('keydown', onKeydown);
      observer.disconnect();
      search.destroy();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return container;
}

export function updateDashboardHomeView(): void {
  refreshConnectionManager();
}
