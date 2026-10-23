// Shared transfer-history store.
//
// Every session's TransferHistoryManager used to load its own copy of the
// list and write that copy back whole, so the last session (or window) to
// save erased the others' records, and each new session marked transfers
// still running elsewhere as "interrupted by restart". Now one store per
// window holds the records this window started (live objects), and every
// save merges them into what is in storage, so records from other sessions
// and windows survive.
//
// A running transfer refreshes its `heartbeat` when it is saved; one that is
// still active in storage but has not been refreshed for STALE_ACTIVE_MS and
// is not this window's belonged to a window or app run that is gone.
//
// No DOM access, so it runs under `node --test`.

import type { TransferRecord } from './file-transfer-history';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const TRANSFER_STORAGE_KEY = 'meterm-transfer-history';
export const MAX_TRANSFER_RECORDS = 200;
/** Heartbeat interval for running transfers, and how stale a foreign one may get. */
export const HEARTBEAT_MS = 5_000;
export const STALE_ACTIVE_MS = 30_000;

export function isActiveTransfer(record: TransferRecord): boolean {
  return record.status === 'inprogress' || record.status === 'paused' || record.status === 'pending';
}

export class TransferStore {
  private readonly owned = new Map<string, TransferRecord>();
  private readonly deleted = new Set<string>();
  private cache: TransferRecord[] | null = null;

  private readonly storage: KeyValueStorage;
  private readonly interruptedText: () => string;
  private readonly now: () => number;

  constructor(storage: KeyValueStorage, interruptedText: () => string, now: () => number = () => Date.now()) {
    this.storage = storage;
    this.interruptedText = interruptedText;
    this.now = now;
  }

  /** Drop the cached list, e.g. after another window wrote storage. */
  invalidate(): void { this.cache = null; }

  private readStored(): TransferRecord[] {
    try {
      const parsed = JSON.parse(this.storage.getItem(TRANSFER_STORAGE_KEY) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter(r => r && typeof r.id === 'string') : [];
    } catch { return []; }
  }

  /** All records, newest first: this window's live ones merged into storage. */
  list(): TransferRecord[] {
    if (this.cache) return this.cache;
    const byId = new Map<string, TransferRecord>();
    for (const stored of this.readStored()) {
      if (this.deleted.has(stored.id)) continue;
      const live = this.owned.get(stored.id);
      if (live) { byId.set(stored.id, live); continue; }
      if (isActiveTransfer(stored) && this.now() - (stored.heartbeat ?? stored.timestamp) > STALE_ACTIVE_MS) {
        byId.set(stored.id, { ...stored, status: 'failed', error: this.interruptedText() });
      } else {
        byId.set(stored.id, stored);
      }
    }
    for (const [id, live] of this.owned) if (!byId.has(id)) byId.set(id, live);
    this.cache = [...byId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_TRANSFER_RECORDS);
    return this.cache;
  }

  find(id: string): TransferRecord | undefined {
    return this.owned.get(id) ?? this.list().find(r => r.id === id);
  }

  /** Records started in this window; their objects are updated in place. */
  isOwned(id: string): boolean { return this.owned.has(id); }

  add(record: TransferRecord): void {
    this.owned.set(record.id, record);
    this.save();
  }

  remove(ids: Iterable<string>): void {
    for (const id of ids) { this.deleted.add(id); this.owned.delete(id); }
    this.save();
  }

  save(): void {
    const now = this.now();
    for (const record of this.owned.values()) if (isActiveTransfer(record)) record.heartbeat = now;
    this.cache = null;
    const merged = this.list();
    try {
      this.storage.setItem(TRANSFER_STORAGE_KEY, JSON.stringify(merged));
    } catch (err) {
      console.error('Failed to save transfer history:', err);
    }
  }
}
