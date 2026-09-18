export const WATCH_BUFFER_LIMIT = 64 * 1024;
export function watchTimeoutSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(300, Math.max(3, value)) : 60;
}

/** Bounded output and deadline/abort lifecycle; never sends terminal input. */
export function createWatchLifecycle(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  finish: (reason: 'aborted' | 'timeout') => void,
) {
  let buffer = '';
  let truncated = false;
  let disposed = false;
  const onAbort = () => { if (!disposed) finish('aborted'); };
  const timer = setTimeout(() => { if (!disposed) finish('timeout'); }, timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    start() { if (signal?.aborted) onAbort(); },
    append(data: string) {
      if (disposed) return;
      const combined = buffer + data;
      truncated ||= combined.length > WATCH_BUFFER_LIMIT;
      buffer = combined.slice(-WATCH_BUFFER_LIMIT);
    },
    get output() { return buffer; },
    get wasTruncated() { return truncated; },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}
