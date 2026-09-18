import { t, type Translations } from './i18n';
import { CONNECTION_SORT_MODES, getGroupSort, setGroupSort } from './connection-sort';

const labels: (keyof Translations)[] = [
  'connectionSortDefault', 'connectionSortIpAsc', 'connectionSortIpDesc',
  'connectionSortNameAsc', 'connectionSortNameDesc',
];
let closeActive: (() => void) | null = null;
let activeAnchor: HTMLElement | null = null;

export function showGroupSortMenu(anchor: HTMLButtonElement, group: string, refresh: () => void): void {
  const toggleOff = activeAnchor === anchor;
  closeActive?.();
  if (toggleOff) return;
  const menu = document.createElement('div');
  menu.className = 'home-card-menu connection-sort-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('connectionSort'));
  anchor.setAttribute('aria-expanded', 'true');
  activeAnchor = anchor;
  const current = getGroupSort(group);
  const buttons: HTMLButtonElement[] = [];
  const focusAnchor = () => {
    const replacement = Array.from(document.querySelectorAll<HTMLButtonElement>('.hsg-sort'))
      .find(button => button.dataset.group === group);
    (anchor.isConnected ? anchor : replacement)?.focus();
  };
  const close = () => {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', close);
    closeActive = null;
    activeAnchor = null;
  };
  const outside = (event: Event) => {
    if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) close();
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
      setGroupSort(group, mode);
      close();
      refresh();
      focusAnchor();
    };
    buttons.push(button);
    menu.appendChild(button);
  });
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 4))}px`;
  closeActive = close;
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', close);
  buttons[CONNECTION_SORT_MODES.indexOf(current)].focus();
}
