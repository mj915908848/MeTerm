import { t, type Translations } from './i18n';
import {
  CONNECTION_SORT_DIRECTIONS, CONNECTION_SORT_KEYS, getGroupSort, setGroupSort,
  sortModeDirection, sortModeKey, type ConnectionSortDirection, type ConnectionSortKey,
} from './connection-sort';

const keyLabels: Record<ConnectionSortKey, keyof Translations> = {
  name: 'connectionSortByName', added: 'connectionSortByAdded',
};
const directionLabels: Record<ConnectionSortDirection, keyof Translations> = {
  asc: 'connectionSortAsc', desc: 'connectionSortDesc',
};
let closeActive: (() => void) | null = null;
let activeAnchor: HTMLElement | null = null;

/**
 * The sort menu: what to sort by (name / date added) above, the direction
 * below. `anchor` is the button it drops from, or the pointer position of a
 * right-click on a group header. `groups` is one group's sort scope, or several
 * (the list toolbar's "sort all"): a pick applies to each, and an entry is only
 * checked when every one of them already uses it. A pick keeps the menu open,
 * so key and direction can both be set in one go.
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
  const shared = <V>(read: (scope: string) => V): V | null => {
    const first = read(scopes[0]);
    return scopes.every(scope => read(scope) === first) ? first : null;
  };
  const currentKey = () => shared(scope => sortModeKey(getGroupSort(scope)));
  const currentDirection = () => shared(scope => sortModeDirection(getGroupSort(scope)));
  const items: { button: HTMLButtonElement; label: string; checked: () => boolean }[] = [];
  const sync = () => {
    for (const { button, label, checked } of items) {
      const on = checked();
      button.setAttribute('aria-checked', String(on));
      button.textContent = `${on ? '✓' : '\u2003'} ${label}`;
    }
  };
  const addItem = (label: string, checked: () => boolean, pick: (scope: string) => void) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.className = 'home-card-menu-item';
    button.setAttribute('role', 'menuitemradio');
    button.onclick = () => {
      for (const scope of scopes) pick(scope);
      sync();
      refresh();
    };
    items.push({ button, label, checked });
    buttons.push(button);
    menu.appendChild(button);
  };
  for (const key of CONNECTION_SORT_KEYS) {
    addItem(t(keyLabels[key]), () => currentKey() === key,
      scope => setGroupSort(scope, `${key}-${sortModeDirection(getGroupSort(scope))}`));
  }
  const divider = document.createElement('div');
  divider.className = 'custom-context-menu-divider';
  divider.setAttribute('role', 'separator');
  menu.appendChild(divider);
  for (const direction of CONNECTION_SORT_DIRECTIONS) {
    addItem(t(directionLabels[direction]), () => currentDirection() === direction,
      scope => setGroupSort(scope, `${sortModeKey(getGroupSort(scope))}-${direction}`));
  }
  sync();
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
  buttons[Math.max(0, items.findIndex(item => item.checked()))].focus();
}
