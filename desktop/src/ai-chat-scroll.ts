// ─── AI chat: scroll following ─────────────────────────────
// The message list follows new content (stream tokens, tool cards,
// notices) only while the reader is at the end. Scrolling up to reread
// stops the following and shows a "jump to latest" button; scrolling
// back down, or clicking the button, resumes it.

import { t } from './i18n';

/** Within this many px of the end counts as "at the end". */
const FOLLOW_SLACK_PX = 40;

const JUMP_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="3" x2="8" y2="13"/><polyline points="3.5 8.5 8 13 12.5 8.5"/></svg>`;

const jumpButtons = new WeakMap<Element, HTMLButtonElement>();

function atEnd(container: Element): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= FOLLOW_SLACK_PX;
}

/** Whether new content should keep this list pinned to its end. */
export function isFollowing(container: Element): boolean {
  return (container as HTMLElement).dataset?.follow !== '0';
}

function setFollowing(container: Element, follow: boolean): void {
  const el = container as HTMLElement;
  if (el.dataset) el.dataset.follow = follow ? '1' : '0';
  jumpButtons.get(container)?.classList.toggle('visible', !follow);
}

/**
 * Wire scroll tracking and the jump button for a message list.
 * `host` is the positioned element the button floats in.
 */
export function installChatScrollFollow(container: HTMLElement, host: HTMLElement): void {
  if (jumpButtons.has(container)) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ai-chat-jump';
  btn.title = t('aiJumpToLatest');
  btn.setAttribute('aria-label', t('aiJumpToLatest'));
  btn.innerHTML = JUMP_ICON;
  btn.addEventListener('click', () => scrollChatToEnd(container, true));
  host.appendChild(btn);
  jumpButtons.set(container, btn);
  container.addEventListener('scroll', () => {
    // Hidden lists report zero sizes; don't let that flip the state.
    if (container.clientHeight === 0) return;
    setFollowing(container, atEnd(container));
  }, { passive: true });
}

/**
 * Scroll to the newest content if the reader is following it.
 * `force` is for content the user must see now: their own message,
 * a confirmation card, a restored conversation.
 */
export function scrollChatToEnd(container: Element | null | undefined, force = false): void {
  if (!container) return;
  if (force || isFollowing(container)) {
    container.scrollTop = container.scrollHeight;
    setFollowing(container, true);
  } else {
    // Content arrived below the fold: make sure the button is offered.
    setFollowing(container, false);
  }
}
