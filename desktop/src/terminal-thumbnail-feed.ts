import type { ManagedTerminal } from './terminal-types';

/**
 * Output feed for the per-tab thumbnail terminal.
 *
 * The thumbnail is a second xterm that only the home view and gallery show,
 * yet it received (and rendered) every output frame. Frames are now batched
 * and written at most every THUMBNAIL_FLUSH_MS, and a change counter lets the
 * capture path skip re-encoding a PNG when nothing changed.
 */
const THUMBNAIL_FLUSH_MS = 500;

const pending = new WeakMap<ManagedTerminal, Uint8Array[]>();
const timers = new WeakMap<ManagedTerminal, ReturnType<typeof setTimeout>>();
const versions = new WeakMap<ManagedTerminal, number>();

export function feedThumbnail(mt: ManagedTerminal, data: Uint8Array): void {
  if (!mt.thumbnailTerminal) return;
  let chunks = pending.get(mt);
  if (!chunks) {
    chunks = [];
    pending.set(mt, chunks);
  }
  // The caller may reuse its buffer; keep our own copy.
  chunks.push(data.slice());
  if (!timers.has(mt)) {
    timers.set(mt, setTimeout(() => flushThumbnail(mt), THUMBNAIL_FLUSH_MS));
  }
}

/** Write any batched output now (before a capture or a resize). */
export function flushThumbnail(mt: ManagedTerminal): void {
  const timer = timers.get(mt);
  if (timer) clearTimeout(timer);
  timers.delete(mt);
  const chunks = pending.get(mt);
  if (!chunks || chunks.length === 0) return;
  pending.delete(mt);
  markThumbnailChanged(mt);
  if (!mt.thumbnailTerminal || mt.ended) return;
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  mt.thumbnailTerminal.write(merged);
}

/** Anything that changes the thumbnail's pixels besides output (theme, font, size). */
export function markThumbnailChanged(mt: ManagedTerminal): void {
  versions.set(mt, (versions.get(mt) ?? 0) + 1);
}

export function thumbnailVersion(mt: ManagedTerminal): number {
  return versions.get(mt) ?? 0;
}

export function discardThumbnailFeed(mt: ManagedTerminal): void {
  const timer = timers.get(mt);
  if (timer) clearTimeout(timer);
  timers.delete(mt);
  pending.delete(mt);
}
