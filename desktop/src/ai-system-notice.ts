/**
 * System notices in the chat (retries, context compression, mode switches)
 * render as one centered pill so they read as timeline events, not as part
 * of a reply. Live and restored conversations share this builder so the two
 * look the same.
 */
export type NoticeTone = 'info' | 'warn';

const ICON_INFO = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4M8 4.8v.01" stroke-linecap="round"/></svg>';
const ICON_WARN = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 2.2 14.2 13H1.8z" stroke-linejoin="round"/><path d="M8 6.5v3.2M8 11.3v.01" stroke-linecap="round"/></svg>';

/** Older notices were framed as "── text ──"; the pill does that job now. */
export function stripNoticeRule(text: string): string {
  return text.replace(/^[─—-]{2,}\s*/, '').replace(/\s*[─—-]{2,}$/, '');
}

export function buildSystemNotice(text: string, tone: NoticeTone = 'info'): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ai-system-notice';
  row.dataset.tone = tone;
  const pill = document.createElement('span');
  pill.className = 'ai-system-notice-pill';
  pill.innerHTML = tone === 'warn' ? ICON_WARN : ICON_INFO;
  const label = document.createElement('span');
  label.textContent = stripNoticeRule(text);
  pill.appendChild(label);
  row.appendChild(pill);
  return row;
}
