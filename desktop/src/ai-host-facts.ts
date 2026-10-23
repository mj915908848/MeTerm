// ─── AI Agent: per-session host facts ──────────────────────────
// Remote OS name per SSH session, read once over SFTP from
// /etc/os-release (nothing is typed into the terminal) and cached for
// the life of the session. A host without that file (macOS, BSD,
// Windows OpenSSH) is remembered as unknown, so the lookup is not
// retried on every run; a session whose SFTP is not up yet is retried.

import { invoke } from '@tauri-apps/api/core';
import { onTerminalSessionDisposed } from './terminal-session-lifecycle';
import { parseOsRelease } from './ai-env-facts';

const remoteOs = new Map<string, string | null>();
const pending = new Map<string, Promise<void>>();

/** Cached remote OS name, or undefined when unknown / not looked up yet. */
export function remoteOsFor(sessionId: string): string | undefined {
  return remoteOs.get(sessionId) ?? undefined;
}

/** Look up the remote OS once per session; resolves within `timeoutMs`. */
export function ensureRemoteOs(sessionId: string, timeoutMs = 2000): Promise<void> {
  if (remoteOs.has(sessionId)) return Promise.resolve();
  let lookup = pending.get(sessionId);
  if (!lookup) {
    lookup = invoke<{ content: string | null }>('sftp_read_file', {
      sessionId,
      path: '/etc/os-release',
      startLine: 1,
      maxLines: 50,
    })
      .then((r) => { remoteOs.set(sessionId, parseOsRelease(r.content ?? '')); })
      .catch((e) => {
        // SFTP starts in the background after connect; ask again next run.
        if (!/SFTP not available/i.test(String(e))) remoteOs.set(sessionId, null);
      })
      .finally(() => { pending.delete(sessionId); });
    pending.set(sessionId, lookup);
  }
  return Promise.race([lookup, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

onTerminalSessionDisposed((sessionId) => {
  remoteOs.delete(sessionId);
});
