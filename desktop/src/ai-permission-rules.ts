// ─── AI Agent: Permission Modes & Rule Engine ──────────────
// Modeled on Claude Code's permission system but simplified to fit
// MeTerm's 3-level trust model.
//
//   PermissionMode: coarse-grained default behavior
//   PermissionRule: fine-grained allow/deny overrides with regex
//
// Evaluation order: user rules → mode default → handler heuristic
// (requiresConfirm / isDestructive).  First match wins.

import type { ToolContext, ToolHandler } from './ai-tools-core';

// ─── Permission Modes ──────────────────────────────────────

export type PermissionMode =
  /** Ask for confirmation on EVERY tool call (corresponds to trust level 0). */
  | 'ask'
  /** Auto-approve scoped reads; ask before shell commands and sensitive/out-of-scope reads. */
  | 'acceptSafe'
  /** Auto-approve unless the call is catastrophic (trust level 2). */
  | 'acceptAll'
  /**
   * Plan mode allows scoped read-only tools and todo planning. Sensitive or
   * out-of-workspace reads require confirmation; mutating tools are denied.
   */
  | 'plan'
  /**
   * Bypass mode: no confirmation, no rule check, no denial. Intended for
   * CI / automation.  Must be opt-in via an explicit setting flag.
   */
  | 'bypass';

/** Map the legacy trust-level number to a PermissionMode. */
export function trustLevelToMode(level: number): PermissionMode {
  switch (level) {
    case 0: return 'ask';
    case 1: return 'acceptSafe';
    case 2: return 'acceptAll';
    default: return 'ask';
  }
}

// ─── Permission Rules ──────────────────────────────────────

export interface PermissionRuleMatch {
  /** Regex applied to args.command (for run_command). */
  command?: string;
  /** Regex applied to args.path (for read_file / write_file). */
  path?: string;
}

export interface PermissionRule {
  /** Tool name this rule applies to. '*' matches any. */
  tool: string;
  /** Optional argument matchers — if omitted, rule applies to all args. */
  match?: PermissionRuleMatch;
  /** Decision when the rule matches. */
  action: 'allow' | 'deny' | 'ask';
}

export type PermissionDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask' };

type CompiledPattern =
  | { kind: 'absent' }
  | { kind: 'valid'; regex: RegExp }
  | { kind: 'invalid' };

/** Compile a user pattern without conflating invalid input with no matcher. */
function safeCompile(pattern?: string): CompiledPattern {
  if (pattern === undefined || pattern === '') return { kind: 'absent' };
  if (typeof pattern !== 'string') return { kind: 'invalid' };
  if (!pattern.trim()) return { kind: 'absent' };
  try {
    return { kind: 'valid', regex: new RegExp(pattern) };
  } catch {
    return { kind: 'invalid' };
  }
}

export function validatePermissionRule(rule: PermissionRule): string | null {
  if (safeCompile(rule.match?.command).kind === 'invalid') {
    return 'Invalid command regular expression.';
  }
  if (safeCompile(rule.match?.path).kind === 'invalid') {
    return 'Invalid path regular expression.';
  }
  return null;
}

interface CompiledRule {
  rule: PermissionRule;
  command: CompiledPattern;
  path: CompiledPattern;
}

function compileRule(rule: PermissionRule): CompiledRule {
  return {
    rule,
    command: safeCompile(rule.match?.command),
    path: safeCompile(rule.match?.path),
  };
}

function ruleMatches(
  compiled: CompiledRule,
  toolName: string,
  args: Record<string, unknown>,
): boolean | 'invalid' {
  const { rule, command, path } = compiled;
  if (rule.tool !== '*' && rule.tool !== toolName) return false;
  if (command.kind === 'invalid' || path.kind === 'invalid') return 'invalid';

  if (command.kind === 'valid') {
    const cmd = typeof args.command === 'string' ? args.command : '';
    if (!command.regex.test(cmd)) return false;
  }
  if (path.kind === 'valid') {
    const p = typeof args.path === 'string' ? args.path : '';
    if (!path.regex.test(p)) return false;
  }
  return true;
}

const SENSITIVE_PATH_PARTS = new Set([
  '.ssh', '.gnupg', '.aws', '.kube', '.docker', 'keychains',
  'vault', 'credentials', 'credential', 'auth.json', 'secrets', 'token', 'password', 'passwords',
  '.token', '.credentials',
  '.netrc', '.npmrc', '.pypirc', '.git-credentials',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);

const SENSITIVE_PATH_SEQUENCES = [
  ['.config', 'google-chrome'],
  ['.config', 'chromium'],
  ['.config', 'microsoft-edge'],
  ['.config', 'bravesoftware', 'brave-browser'],
  ['.config', 'gcloud'],
  ['.mozilla', 'firefox'],
  ['.local', 'share', 'keyrings'],
  ['library', 'application support', 'google', 'chrome'],
  ['library', 'application support', 'chromium'],
  ['library', 'application support', 'microsoft', 'edge'],
  ['library', 'application support', 'bravesoftware', 'brave-browser'],
  ['library', 'application support', 'firefox', 'profiles'],
  ['library', 'safari'],
  ['library', 'containers', 'com.apple.safari'],
  ['appdata', 'local', 'google', 'chrome', 'user data'],
  ['appdata', 'local', 'microsoft', 'edge', 'user data'],
  ['appdata', 'roaming', 'mozilla', 'firefox', 'profiles'],
  ['appdata', 'roaming', 'microsoft', 'credentials'],
  ['appdata', 'local', 'microsoft', 'credentials'],
  ['appdata', 'local', 'microsoft', 'vault'],
];

function hasSensitivePathComponent(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean).map((part) => part.toLowerCase());
  if (SENSITIVE_PATH_SEQUENCES.some((sequence) => parts.some((_, start) =>
    sequence.every((part, index) => parts[start + index] === part)))) {
    return true;
  }
  return parts.some((part, index) => {
    if (SENSITIVE_PATH_PARTS.has(part)) return true;
    if (part.startsWith('.env') || part.startsWith('.secret')) return true;
    if (part.startsWith('credentials.') || part.startsWith('secret') || part.startsWith('password')) return true;
    if (part.startsWith('token.') || part.endsWith('.pem') || part.endsWith('.key')
      || part.endsWith('.p8') || part.endsWith('.p12') || part.endsWith('.pfx')
      || part.endsWith('.der') || part.endsWith('.crt') || part.endsWith('.cer')
      || part.endsWith('.jks') || part.endsWith('.keystore')
      || part.endsWith('.p7b') || part.endsWith('.p7c')) return true;
    if (part.endsWith('.tfstate') || part.endsWith('.tfstate.backup')) return true;
    return part === 'config.json' && parts[index - 1] === '.docker';
  });
}

interface NormalizedPath {
  root: string;
  parts: string[];
}

function normalizeAbsolutePath(input: string, cwd: string, isSSH: boolean): NormalizedPath | null {
  const value = input.trim().replace(/\\/g, '/');
  if (!value || value.startsWith('~') || value.startsWith('//')) return null;
  const windowsDrive = !isSSH && /^([a-z]):\//i.exec(value);
  const isAbsolute = value.startsWith('/') || !!windowsDrive;
  const base = cwd.trim().replace(/\\/g, '/');
  if (!isAbsolute && (!base.startsWith('/') && (!isSSH && !/^[a-z]:\//i.test(base)))) return null;
  const joined = isAbsolute ? value : `${base.replace(/\/$/, '')}/${value}`;
  const drive = !isSSH && /^([a-z]):\//i.exec(joined);
  const root = drive ? `${drive[1].toLowerCase()}:` : '/';
  const body = drive ? joined.slice(3) : joined.replace(/^\//, '');
  const parts: string[] = [];
  for (const part of body.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return { root, parts };
}

function pathIsWithinWorkspace(path: string, cwd: string, isSSH: boolean): boolean {
  const resolved = normalizeAbsolutePath(path, cwd, isSSH);
  const workspace = normalizeAbsolutePath(cwd, cwd, isSSH);
  if (!resolved || !workspace || resolved.root.toLowerCase() !== workspace.root.toLowerCase()) return false;
  if (resolved.parts.length < workspace.parts.length) return false;
  const fold = (value: string) => !isSSH && /^[a-z]:$/.test(workspace.root) ? value.toLowerCase() : value;
  return workspace.parts.every((part, index) => fold(resolved.parts[index]) === fold(part));
}

function targetPane(context: ToolContext | undefined, args: Record<string, unknown>) {
  if (!context) return undefined;
  const paneNum = Number(args.pane);
  if (Number.isInteger(paneNum) && paneNum > 0) {
    return context.panes.find((pane) => pane.paneNumber === paneNum);
  }
  return context.panes.find((pane) => pane.isDefaultTarget) ?? context.panes[0];
}

export function requiresReadScopeConfirmation(
  toolName: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): boolean {
  if (!['read_file', 'grep_search', 'glob_search', 'list_directory'].includes(toolName)) return false;
  const pane = targetPane(context, args);
  const cwd = (pane?.cwd ?? context?.cwd ?? '').trim();
  const isSSH = pane?.isSSH ?? context?.isSSH ?? false;
  // Remote canonical paths are not available before the permission decision;
  // require explicit approval rather than trusting a lexical path through SSH.
  if (isSSH) return true;
  const pathArg = toolName === 'glob_search' ? args.cwd : args.path;
  const targetPath = typeof pathArg === 'string' && pathArg.trim() ? pathArg.trim() : cwd;
  if (!targetPath || !cwd || hasSensitivePathComponent(targetPath)) return true;
  return !pathIsWithinWorkspace(targetPath, cwd, isSSH);
}

// ─── Default Rule Set ──────────────────────────────────────
// Ships with conservative defaults that users can override via
// settings (aiPermissionRules, to be wired into settings UI later).

export const DEFAULT_PERMISSION_RULES: PermissionRule[] = [
  // Deny: anything that writes to sensitive files.
  { tool: 'write_file', match: { path: '\\.ssh/|\\.env$|\\.env\\.|/etc/' }, action: 'deny' },
  // Deny: destructive git operations even in acceptAll mode.
  { tool: 'run_command', match: { command: '^\\s*git\\s+push\\s+.*--force' }, action: 'deny' },
  { tool: 'run_command', match: { command: '^\\s*git\\s+reset\\s+--hard' }, action: 'deny' },
  // Ask: sudo, curl mutations, wget POST, destructive disk ops.
  { tool: 'run_command', match: { command: '^\\s*sudo\\s+' }, action: 'ask' },
  { tool: 'run_command', match: { command: '\\bcurl\\b.*(-X\\s*(POST|PUT|DELETE|PATCH)|--data|--upload-file|-d\\s)' }, action: 'ask' },
  { tool: 'run_command', match: { command: '\\bwget\\b.*--post' }, action: 'ask' },
];

// ─── Rule Evaluator ────────────────────────────────────────

/**
 * Decide whether a tool call is allowed, denied, or needs confirmation.
 *
 * @param toolName  The tool being invoked.
 * @param args      Parsed tool arguments.
 * @param handler   The registered handler (for fallback heuristics).
 * @param mode      Current PermissionMode.
 * @param rules     User + default rules (first match wins).
 * @param readScopeConfirmation Canonical local-read scope result, when preflighted.
 */
export function decidePermission(
  toolName: string,
  args: Record<string, unknown>,
  handler: ToolHandler | undefined,
  mode: PermissionMode,
  rules: PermissionRule[],
  context?: ToolContext,
  readScopeConfirmation?: boolean,
): PermissionDecision {
  const scopeNeedsConfirmation = readScopeConfirmation
    ?? requiresReadScopeConfirmation(toolName, args, context);

  // Bypass: short-circuit everything.
  if (mode === 'bypass') return { kind: 'allow' };

  // Plan mode: only read-only tools allowed, everything else silently denied.
  // Exception: todo_write is a pure in-memory operation (no filesystem / PTY
  // side effects) and is essential for task planning, so we allow it even
  // though isConcurrencySafe is false (it's serialized, not read-only).
  if (mode === 'plan') {
    if (handler?.isConcurrencySafe || toolName === 'todo_write') {
      return scopeNeedsConfirmation ? { kind: 'ask' } : { kind: 'allow' };
    }
    return {
      kind: 'deny',
      reason: 'Plan mode is active — only read-only tools are allowed. The agent cannot modify anything.',
    };
  }

  // Walk user rules first (first match wins).
  for (const rule of rules) {
    const compiled = compileRule(rule);
    const match = ruleMatches(compiled, toolName, args);
    if (match === 'invalid') {
      if (rule.action === 'deny') {
        return { kind: 'deny', reason: `Denied because a permission rule has an invalid matcher (tool=${rule.tool}).` };
      }
      return { kind: 'ask' };
    }
    if (match) {
      if (rule.action === 'allow') return { kind: 'allow' };
      if (rule.action === 'deny') {
        return { kind: 'deny', reason: `Denied by permission rule (tool=${rule.tool}).` };
      }
      return { kind: 'ask' };
    }
  }

  // Mode defaults (equivalent to legacy trust levels).
  if (!handler) return { kind: 'ask' }; // unknown tool → always ask

  if (mode === 'acceptSafe' && scopeNeedsConfirmation) {
    return { kind: 'ask' };
  }
  // Shell command strings can read arbitrary host files and chain commands;
  // command-name regexes cannot establish that a command is read-only.
  if (mode === 'acceptSafe' && toolName === 'run_command') return { kind: 'ask' };

  switch (mode) {
    case 'ask':
      return { kind: 'ask' };
    case 'acceptSafe':
      return handler.requiresConfirm(args) ? { kind: 'ask' } : { kind: 'allow' };
    case 'acceptAll':
      return handler.isDestructive(args) ? { kind: 'ask' } : { kind: 'allow' };
  }
}
