// ─── Tab marquee (window toolbar) ──
// The window tab strip builds this DOM shape:
//
//   .title-tab
//     .title-tab-track
//       .title-tab-track-inner
//         .title-tab-text.primary      ← measured against the track
//         .title-tab-text.duplicate    ← scrolled into view by the animation
//     .tab-close
//
// and the marquee CSS (`toolbar.css`) keys off `.is-overflowing` plus the
// `--marquee-shift` custom property.
//
// The editor strip deliberately does NOT use this: it plans its widths with
// planTabWidths() so a full host:/path is shown whenever the row can hold it,
// and ellipsises only under pressure. Scrolling a path sideways made it harder,
// not easier, to read at a glance.

/** Space inserted between the primary text and its duplicate, in px. */
const MARQUEE_GAP = 24;

/**
 * Mark a `.title-tab` as needing the marquee, or clear it.
 *
 * MUST be called after layout — `scrollWidth`/`clientWidth` are zero for
 * a detached or not-yet-laid-out element, which would silently clear the
 * marquee. Call it from a `requestAnimationFrame` after inserting tabs.
 *
 * No-ops when the expected inner structure is missing, so a partially
 * built tab cannot throw during a render pass.
 */
export function syncTabMarqueeFor(node: HTMLElement, gap = MARQUEE_GAP): void {
  const primaryEl = node.querySelector('.title-tab-text.primary') as HTMLElement | null;
  const trackEl = node.querySelector('.title-tab-track') as HTMLElement | null;
  const trackInnerEl = node.querySelector('.title-tab-track-inner') as HTMLElement | null;
  const closeEl = node.querySelector('.tab-close') as HTMLElement | null;
  if (!primaryEl || !trackEl || !trackInnerEl || !closeEl) return;

  // +2 tolerates sub-pixel rounding from the flex layout.
  const shouldScroll = primaryEl.scrollWidth > trackEl.clientWidth + 2;
  if (shouldScroll) {
    node.style.setProperty('--marquee-shift', `${primaryEl.scrollWidth + gap}px`);
    node.classList.add('is-overflowing');
  } else {
    node.style.removeProperty('--marquee-shift');
    node.classList.remove('is-overflowing');
    trackInnerEl.style.transform = 'translateX(0)';
  }
}
