/**
 * dock-panel.ts — Shared pieces of the left dock.
 *
 * The left dock holds one panel at a time: the connection list, the server-info
 * panel, or the file sidebar (sidebar mode). They mount as the leftmost child of
 * #main-content and push the terminal aside. This module gives them the same
 * width (persisted as `sidebarWidth`), the same header and the same resize edge,
 * so opening any of them looks and behaves the same.
 */
import { loadSettings, updateSettings } from './themes';

const MIN_WIDTH = 140;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 280;

export function clampDockWidth(w: number): number {
  const max = Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.5));
  return Math.max(MIN_WIDTH, Math.min(max, Math.round(w)));
}

export function loadDockWidth(): number {
  const w = loadSettings().sidebarWidth;
  return w > 0 ? clampDockWidth(w) : DEFAULT_WIDTH;
}

/** Put `panel` first in #main-content (left of the terminal). */
export function mountInDock(panel: HTMLElement): boolean {
  const mainContent = document.getElementById('main-content');
  if (!mainContent) return false;
  if (panel.parentElement !== mainContent || mainContent.firstChild !== panel) {
    mainContent.insertBefore(panel, mainContent.firstChild);
  }
  return true;
}

/** Title + close button, the header every dock panel starts with. */
export function createDockHeader(title: string, closeLabel: string, onClose: () => void): HTMLElement {
  const header = document.createElement('div');
  header.className = 'dock-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'dock-title';
  titleEl.textContent = title;
  header.appendChild(titleEl);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'dock-close';
  closeBtn.title = closeLabel;
  closeBtn.setAttribute('aria-label', closeLabel);
  closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 9 9M9 1 1 9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  closeBtn.onclick = onClose;
  header.appendChild(closeBtn);
  return header;
}

/**
 * Drag the right edge to resize. The width is persisted and shared by every dock
 * panel, so switching between them keeps the same geometry.
 */
export function attachDockResizer(panel: HTMLElement, onResize?: () => void): void {
  const resizer = document.createElement('div');
  resizer.className = 'dock-resizer';
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    let latestW = startW;
    let raf = 0;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      latestW = clampDockWidth(startW + (ev.clientX - startX));
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          panel.style.width = `${latestW}px`;
          onResize?.();
        });
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      resizer.classList.remove('dragging');
      panel.style.width = `${latestW}px`;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      updateSettings({ sidebarWidth: latestW });
      onResize?.();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  panel.appendChild(resizer);
}
