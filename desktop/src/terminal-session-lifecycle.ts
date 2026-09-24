type SessionDisposedListener = (sessionId: string) => void;

const sessionDisposedListeners = new Set<SessionDisposedListener>();

/** Register session cleanup without importing the terminal registry. */
export function onTerminalSessionDisposed(listener: SessionDisposedListener): () => void {
  sessionDisposedListeners.add(listener);
  return () => { sessionDisposedListeners.delete(listener); };
}

/** Notify every cleanup listener; one faulty listener must not block teardown. */
export function notifyTerminalSessionDisposed(sessionId: string): void {
  for (const listener of sessionDisposedListeners) {
    try {
      listener(sessionId);
    } catch {
      // A misbehaving disposer must not break session teardown.
    }
  }
}
