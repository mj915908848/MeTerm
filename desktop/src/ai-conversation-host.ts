export type ConversationHost = { kind: 'local' } | { kind: 'ssh'; address: string; port: number; displayName: string };
export function sshConversationHost(address: string, port: number): ConversationHost {
  const normalized = address.trim().toLowerCase();
  return { kind: 'ssh', address: normalized, port, displayName: `${normalized}:${port}` };
}
export function hostsMatch(a: ConversationHost | undefined, b: ConversationHost | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'local') return true;
  return b.kind === 'ssh' && a.address.trim().toLowerCase() === b.address.trim().toLowerCase() && a.port === b.port;
}
export function validHost(raw: unknown): ConversationHost | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const host = raw as Record<string, unknown>;
  if (host.kind === 'local') return { kind: 'local' };
  if (host.kind === 'ssh' && typeof host.address === 'string' && host.address.trim() &&
      typeof host.port === 'number' && Number.isInteger(host.port) && host.port > 0 && host.port <= 65535) {
    return sshConversationHost(host.address, host.port);
  }
  return undefined;
}
