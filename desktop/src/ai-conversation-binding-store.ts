import type { ConversationHost } from './ai-conversation-host';
// Explicit `.ts` extension is required: this module is loaded directly by
// `node --test`, which does not resolve extensionless relative imports.
import { validHost } from './ai-conversation-host.ts';

export interface BindingStorage {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}
const pending = new Set<string>();
function historyPath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid conversation ID');
  return `chat-history/${id}.json`;
}
/** Read disk afresh; retain legacy format/unknown fields and back up before atomic replacement. */
export async function bindLegacyHistory(id: string, host: ConversationHost, storage: BindingStorage): Promise<void> {
  const path = historyPath(id);
  const binding = validHost(host);
  if (!binding) throw new Error('Invalid host');
  if (pending.has(id)) throw new Error('Binding already in progress');
  pending.add(id);
  try {
    const original = await storage.read(path);
    const raw = JSON.parse(original);
    if (!raw || raw.id !== id || !Array.isArray(raw.messages)) throw new Error('Invalid history');
    if (raw.hostBinding != null) throw new Error('Conversation is already bound');
    const backup = `${path}.pre-host-binding.bak`;
    if (!(await storage.exists(backup))) await storage.write(backup, original);
    const temporary = `${path}.binding.tmp`;
    try {
      await storage.write(temporary, JSON.stringify({ ...raw, hostBinding: binding }));
      await storage.rename(temporary, path);
    } catch (error) {
      // Preserve the original and its backup; a failed staging file is not a backup.
      try { if (await storage.exists(temporary)) await storage.remove(temporary); }
      catch (cleanupError) { console.warn('[chat-history] temporary cleanup failed:', cleanupError); }
      throw error;
    }
  } finally { pending.delete(id); }
}

/** Explicit deletion also removes only this conversation's known sidecars. */
export async function deleteHistoryFiles(id: string, storage: Pick<BindingStorage, 'exists' | 'remove'>): Promise<void> {
  const path = historyPath(id);
  if (pending.has(id)) throw new Error('History operation already in progress');
  pending.add(id);
  try {
    // If primary deletion fails, retain the last recovery copy.
    if (await storage.exists(path)) await storage.remove(path);
    const failures: unknown[] = [];
    for (const sidecar of [`${path}.pre-host-binding.bak`, `${path}.binding.tmp`]) {
      try { if (await storage.exists(sidecar)) await storage.remove(sidecar); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'History sidecar cleanup failed');
  } finally { pending.delete(id); }
}
