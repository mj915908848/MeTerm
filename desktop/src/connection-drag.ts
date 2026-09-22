/**
 * connection-drag.ts — drag connection rows onto a group header.
 *
 * Mouse events, not HTML5 drag-and-drop. The WebView sits between the page and
 * the platform drag session (Tauri registers the webview as a file-drop target),
 * and the app's other reordering gesture — the home view's group cards — is
 * mouse-based for the same reason. Mouse events also give the drop highlight and
 * the edge auto-scroll for free.
 *
 * Event delegation on the list container: the list is re-rendered wholesale on
 * every mutation, so per-row listeners would have to be re-attached each time.
 *
 * A drag that starts on a row which is part of the selection carries the whole
 * selection; a drag from anywhere else carries only that row.
 */
import { keysToDrag } from './connection-selection';

/** Group name of the "not in any group" bucket, mirroring home-side.ts. */
const UNGROUPED = '__ungrouped__';
const DRAG_THRESHOLD = 4;
const EDGE_ZONE = 26;
const EDGE_STEP = 9;
const HOVER_CLASS = 'drop-target';

export interface ConnectionDragOptions {
  /** Rows currently picked; a drag starting on one of them carries them all. */
  getSelection: () => readonly string[];
  /** Destination group (`null` = the ungrouped bucket) and the dragged rows. */
  onDrop: (group: string | null, keys: string[]) => void;
  /** Localised ghost label, e.g. "3 个连接". */
  dragLabel: (count: number) => string;
}

/**
 * Make the rows inside `listEl` draggable onto group headers.
 *
 * Returns a disposer; the caller keeps one controller per rendered list, not one
 * per render.
 */
export function attachConnectionDrag(
  listEl: HTMLElement,
  opts: ConnectionDragOptions,
): () => void {
  let armed = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let pointerX = 0;
  let pointerY = 0;
  let keys: string[] = [];
  let ghost: HTMLElement | null = null;
  let marked: HTMLElement | null = null;
  let scrollRaf = 0;

  const groupOfHeader = (header: HTMLElement): string | null => {
    const raw = header.dataset.group;
    return !raw || raw === UNGROUPED ? null : raw;
  };

  /** The group the pointer is over, or `undefined` when it is over neither a row nor a header. */
  const pointedGroup = (): string | null | undefined => {
    const el = document.elementFromPoint(pointerX, pointerY) as HTMLElement | null;
    if (!el) return undefined;
    const header = el.closest('.home-side-group') as HTMLElement | null;
    if (header) return groupOfHeader(header);
    // Hovering a row counts as hovering its group, which makes the target the
    // whole row instead of a thin header line.
    const row = el.closest('.home-side-row') as HTMLElement | null;
    if (!row) return undefined;
    const raw = row.dataset.group;
    return !raw || raw === UNGROUPED ? null : raw;
  };

  /** The header element for a group. Document scope: the single-group header is
   *  hoisted out of the list into a fixed slot above it. */
  const headerFor = (group: string | null): HTMLElement | null => {
    const wanted = group ?? UNGROUPED;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.home-side-group'))) {
      if ((el.dataset.group ?? '') === wanted) return el;
    }
    return null;
  };

  const mark = (group: string | null | undefined): void => {
    const next = group === undefined ? null : headerFor(group);
    if (next === marked) return;
    marked?.classList.remove(HOVER_CLASS);
    marked = next;
    marked?.classList.add(HOVER_CLASS);
  };

  const beginDrag = (): void => {
    dragging = true;
    listEl.classList.add('is-dragging');
    document.body.classList.add('is-connection-dragging');
    ghost = document.createElement('div');
    ghost.className = 'cn-drag-ghost';
    ghost.textContent = opts.dragLabel(keys.length);
    ghost.style.transform = `translate(${pointerX + 12}px, ${pointerY + 12}px)`;
    document.body.appendChild(ghost);
  };

  /**
   * Scroll when the pointer is near an edge, so a group that has scrolled out of
   * view is still reachable. Stops on its own at either end.
   */
  const edgeScroll = (): void => {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
    const rect = listEl.getBoundingClientRect();
    const delta = pointerY < rect.top + EDGE_ZONE ? -EDGE_STEP
      : pointerY > rect.bottom - EDGE_ZONE ? EDGE_STEP
        : 0;
    if (!delta) return;
    const step = (): void => {
      const before = listEl.scrollTop;
      listEl.scrollTop = before + delta;
      if (listEl.scrollTop === before) { scrollRaf = 0; return; }
      // The list moved under a stationary pointer, so the highlight has to follow.
      mark(pointedGroup());
      scrollRaf = requestAnimationFrame(step);
    };
    scrollRaf = requestAnimationFrame(step);
  };

  const onMove = (event: MouseEvent): void => {
    if (!armed) return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (!dragging) {
      const moved = Math.abs(pointerX - startX) >= DRAG_THRESHOLD
        || Math.abs(pointerY - startY) >= DRAG_THRESHOLD;
      if (!moved) return;
      beginDrag();
    }
    if (ghost) ghost.style.transform = `translate(${pointerX + 12}px, ${pointerY + 12}px)`;
    mark(pointedGroup());
    edgeScroll();
  };

  const cleanup = (): void => {
    armed = false;
    dragging = false;
    keys = [];
    ghost?.remove();
    ghost = null;
    marked?.classList.remove(HOVER_CLASS);
    marked = null;
    cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
    listEl.classList.remove('is-dragging');
    document.body.classList.remove('is-connection-dragging');
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };

  const onUp = (): void => {
    if (!armed) return;
    const group = dragging ? pointedGroup() : undefined;
    const moved = dragging ? [...keys] : [];
    cleanup();
    if (group === undefined) return;
    // A drag is not a click: the row underneath must not also open a session.
    const swallow = (event: Event): void => { event.stopPropagation(); event.preventDefault(); };
    document.addEventListener('click', swallow, true);
    // Dropped outside any row, no click follows — the listener must not stay
    // armed and eat the user's next real click.
    setTimeout(() => document.removeEventListener('click', swallow, true), 400);
    opts.onDrop(group, moved);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (armed && event.key === 'Escape') cleanup();
  };

  const onDown = (event: MouseEvent): void => {
    if (event.button !== 0 || armed) return;
    const target = event.target as HTMLElement | null;
    const row = target?.closest('.home-side-row') as HTMLElement | null;
    if (!row) return;
    // The pin is its own control — arming a drag on it would move rows when the
    // user meant to favourite one.
    if (target?.closest('.hsr-pin')) return;
    const key = row.dataset.key;
    if (!key) return;

    // Suppresses the text-selection drag the platform would otherwise start.
    event.preventDefault();
    armed = true;
    startX = pointerX = event.clientX;
    startY = pointerY = event.clientY;
    keys = keysToDrag(key, opts.getSelection());

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('keydown', onKeyDown, true);
  };

  listEl.addEventListener('mousedown', onDown);

  return () => {
    cleanup();
    listEl.removeEventListener('mousedown', onDown);
  };
}
