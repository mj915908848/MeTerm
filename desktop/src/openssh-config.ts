export const MAX_OPENSSH_CONFIG_BYTES = 128 * 1024;
const MAX_HOSTS = 256;

export interface OpenSshConnection {
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'key';
  privateKey?: string;
  usesDesktopKeyLadder?: true;
}

interface HostPattern {
  pattern: string;
  negated: boolean;
}

interface ConfigBlock {
  patterns?: HostPattern[];
  options: Array<[string, string[]]>;
}

const literalHost = /^[a-z\d_.:-]{1,256}$/i;
const hostPattern = /^[a-z\d_.:*?-]{1,256}$/i;
const usernamePattern = /^[a-z\d_.@-]{1,128}$/i;

function parseArguments(input: string): string[] {
  const words: string[] = [];
  const token = /\s*(?:"([^"\r\n]*)"|([^\s"]+))(?=\s|$)/y;
  let offset = 0;
  while (offset < input.length && !/^\s*(?:#|$)/.test(input.slice(offset))) {
    token.lastIndex = offset;
    const match = token.exec(input);
    if (!match) throw new Error('Invalid OpenSSH config arguments');
    words.push(match[1] ?? match[2]);
    offset = token.lastIndex;
  }
  return words;
}

function parseHostPattern(value: string): HostPattern {
  const negated = value.startsWith('!');
  const pattern = negated ? value.slice(1) : value;
  if (!hostPattern.test(pattern)) throw new Error('Unsupported OpenSSH host pattern');
  return { negated, pattern };
}

function matchesHost(pattern: string, host: string): boolean {
  let index = 0;
  let offset = 0;
  let star = -1;
  let retryOffset = 0;
  while (offset < host.length) {
    if (pattern[index] === '*') {
      star = index++;
      retryOffset = offset;
    } else if (pattern[index] === '?' || pattern[index] === host[offset]) {
      index++;
      offset++;
    } else if (star >= 0) {
      index = star + 1;
      offset = ++retryOffset;
    } else {
      return false;
    }
  }
  return /^\**$/.test(pattern.slice(index));
}

function appliesToHost(block: ConfigBlock, name: string): boolean {
  if (!block.patterns) return true;
  let matched = false;
  for (const { pattern, negated } of block.patterns) {
    if (!matchesHost(pattern, name)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function parseIdentityFile(value: string, windows: boolean): string | undefined {
  if (value.length > 1_000 || /[%\x00-\x1f\x7f]/.test(value) || value.includes('${')) return;
  if (value.startsWith('~/')) return value;
  if (windows) return /^(?:[a-z]:[/\\]|\\\\[^\\])/i.test(value) ? value : undefined;
  return value.startsWith('/') && !value.includes('\\') ? value : undefined;
}

function resolveHost(name: string, blocks: ConfigBlock[], windows: boolean): OpenSshConnection | undefined {
  const options = new Map<string, string>();
  const identities = new Set<string>();
  for (const block of blocks) {
    if (!appliesToHost(block, name)) continue;
    for (const [key, args] of block.options) {
      if (args.length !== 1 || !args[0]) return;
      const [value] = args;
      switch (key) {
        case 'hostname':
        case 'user':
        case 'port':
        case 'identitiesonly':
          if (!options.has(key)) options.set(key, value);
          break;
        case 'identityfile': {
          const path = parseIdentityFile(value, windows);
          if (!path) return;
          identities.add(path);
          break;
        }
        // Agent/keychain convenience settings do not change the selected host.
        case 'addkeystoagent':
        case 'usekeychain':
        case 'serveraliveinterval':
        case 'serveralivecountmax':
          break;
        case 'proxyjump':
        case 'proxycommand':
          if (value.toLowerCase() !== 'none') return;
          break;
        default:
          return;
      }
    }
  }

  const host = options.get('hostname') ?? name;
  const username = options.get('user');
  const portText = options.get('port') ?? '22';
  const port = Number(portText);
  const identitiesOnly = options.get('identitiesonly')?.toLowerCase();
  if (!literalHost.test(host) || !username || !usernamePattern.test(username)) return;
  if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) return;
  if (identities.size > 1 || (identitiesOnly !== undefined && identitiesOnly !== 'yes' && identitiesOnly !== 'no')) return;
  if (identitiesOnly === 'yes' && identities.size === 0) return;

  const [privateKey] = identities;
  return {
    name, host, port, username, authMethod: 'key',
    ...(privateKey ? { privateKey } : { usesDesktopKeyLadder: true }),
  };
}

/** Parse a single file as data. Unsupported options make affected aliases ineligible. */
export function parseOpenSshConfig(source: string, windows = false): { connections: OpenSshConnection[]; skipped: number } {
  if (new TextEncoder().encode(source).length > MAX_OPENSSH_CONFIG_BYTES || source.includes('\0')) {
    throw new Error('Invalid OpenSSH config size or encoding');
  }
  let current: ConfigBlock = { options: [] };
  const blocks = [current];
  const names = new Map<string, string>();
  for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    const directive = /^\s*([a-z][a-z\d]*)(?:\s*=\s*|\s+|$)(.*)$/i.exec(line);
    if (!directive) throw new Error('Invalid OpenSSH config directive');
    const key = directive[1].toLowerCase();
    if (key === 'include' || key === 'match') throw new Error('OpenSSH Include and Match are unsupported');
    if (key !== 'host') {
      current.options.push([key, parseArguments(directive[2])]);
      continue;
    }
    const args = parseArguments(directive[2]);
    if (args.length === 0) throw new Error('OpenSSH Host has no patterns');
    current = { patterns: args.map(parseHostPattern), options: [] };
    blocks.push(current);
    for (const name of args) {
      const normalized = name.toLowerCase();
      if (literalHost.test(name) && !names.has(normalized)) names.set(normalized, name);
    }
    if (names.size > MAX_HOSTS) throw new Error('Too many OpenSSH hosts');
  }

  const connections: OpenSshConnection[] = [];
  for (const name of names.values()) {
    // A name must not resolve to an inherited property of the legacy name map.
    if (Object.prototype.hasOwnProperty.call(Object.prototype, name)
      || !blocks.some(block => block.patterns && appliesToHost(block, name))) continue;
    const connection = resolveHost(name, blocks, windows);
    if (connection) connections.push(connection);
  }
  return { connections, skipped: names.size - connections.length };
}
