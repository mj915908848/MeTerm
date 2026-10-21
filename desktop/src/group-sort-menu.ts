import { t, type Translations } from './i18n';
import { CONNECTION_SORT_MODES, getGroupSort, setGroupSort } from './connection-sort';

const labels: (keyof Translations)[] = [
  'connectionSortDefault', 'connectionSortIpAsc', 'connectionSortIpDesc',
  'connectionSortNameAsc', 'connectionSortNameDesc',
];
let closeActive: (() => void) | null = null;
let activeAnchor: HTMLElement | null = null;

/**
 * The sort-mode menu. `anchor` is the button it drops from, or the pointer
 * position of a right-click on a group header. `groups` is one group's sort
 * scope, or several (the list toolbar's "sort all"): a pick applies to each,
 * and a mode is only checked when every one of them already uses it.
 */
export function showGroupSortMenu(
  anchor: HTMLElement | { x: number; y: number },
  groups: string | readonly string[],
  refresh: () => void,
): void {
  const anchorEl = 'getBoundingClientRect' in anchor ? anchor : null;
  const toggleOff = anchorEl !== null && activeAnchor === anchorEl;
  closeActive?.();
  if (toggleOff) return;
  const scopes = typeof groups === 'string' ? [groups] : groups.slice();
  const menu = document.createElement('div');
  menu.className = 'home-card-menu connection-sort-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('connectionSort'));
  anchorEl?.setAttribute('aria-expanded', 'true');
  activeAnchor = anchorEl;
  const first = getGroupSort(scopes[0]);
  const current = scopes.every(scope => getGroupSort(scope) === first) ? first : null;
  const buttons: HTMLButtonElement[] = [];
  const focusAnchor = () => { if (anchorEl?.isConnected) anchorEl.focus(); };
  const close = () => {
    menu.remove();
    anchorEl?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', close);
    closeActive = null;
    activeAnchor = null;
  };
  const outside = (event: Event) => {
    if (!menu.contains(event.target as Node) && !anchorEl?.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent) => {
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); close(); focusAnchor(); }
    else if (event.key === 'Tab') { close(); focusAnchor(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  };
  CONNECTION_SORT_MODES.forEach((mode, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.className = 'home-card-menu-item';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(mode === current));
    button.textContent = `${mode === current ? '✓' : '\u2003'} ${t(labels[index])}`;
    button.onclick = () => {
      for (const scope of scopes) setGroupSort(scope, mode);
      close();
      refresh();
      focusAnchor();
    };
    buttons.push(button);
    menu.appendChild(button);
  });
  document.body.appendChild(menu);
  let left: number;
  let top: number;
  if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    left = rect.right - menu.offsetWidth;
    top = rect.bottom + 4;
  } else {
    left = (anchor as { x: number }).x;
    top = (anchor as { y: number }).y;
  }
  menu.style.left = `${Math.max(4, Math.min(left, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(top, window.innerHeight - menu.offsetHeight - 4))}px`;
  closeActive = close;
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', close);
  buttons[current ? CONNECTION_SORT_MODES.indexOf(current) : 0].focus();
}
