// ─── AI Agent: Permission Modes & Rule Engine ──────────────
//   PermissionMode: coarse-grained default behavior
//   PermissionRule: fine-grained allow/deny overrides with regex
//
// Explicit rules run before the mode defaults. Canonical read scope
// can still require approval for an otherwise allowed read.
// User rules remain first-match-wins.

import type { ToolContext, ToolHandler } from './ai-tools-core';
import type { TerminalSubmit } from './ai-terminal-submit';

// ─── Permission Modes ──────────────────────────────────────

export type PermissionMode = 'ask' | 'acceptSafe' | 'extendedAccess';

/** Every mode, in the order the settings page and the AI bar list them. */
export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'acceptSafe', 'extendedAccess'];

/** Resolve current settings and migrate older saved permission choices. */
export function effectivePermissionMode(settings: {
  aiPermissionMode?: unknown;
  aiAgentTrustLevel?: number;
}): PermissionMode {
  switch (settings.aiPermissionMode) {
    case 'plan':
    case 'ask':
      return 'ask';
    case 'extendedAccess':
      return 'extendedAccess';
    case 'acceptSafe':
    case 'acceptAll':
    case 'bypass':
      return 'acceptSafe';
    case undefined:
      return settings.aiAgentTrustLevel === 1 || settings.aiAgentTrustLevel === 2 ? 'acceptSafe' : 'ask';
    default:
      return 'ask';
  }
}

// ─── Permission Rules ──────────────────────────────────────

export interface PermissionRuleMatch {
  /** Regex applied to args.command (for run_command). */
  command?: string;
  /** Regex applied to args.path (for read_file / write_file). A write_file
   *  rule also governs edit_file: both change file content. */
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
  if (rule.tool !== '*' && rule.tool !== toolName && !(rule.tool === 'write_file' && toolName === 'edit_file')) {
    return false;
  }
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

export function hasSensitivePathComponent(path: string): boolean {
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
  // Deny: anything that writes credential files.
  { tool: 'write_file', match: { path: '\\.ssh/|\\.env$|\\.env\\.' }, action: 'deny' },
  // Ask: system config. Denying it only pushed the agent to `sudo tee` via
  // run_command, where the user cannot review the change line by line.
  { tool: 'write_file', match: { path: '/etc/' }, action: 'ask' },
  // Deny: destructive git operations in automatic mode.
  { tool: 'run_command', match: { command: '^\\s*git\\s+push\\s+.*--force' }, action: 'deny' },
  { tool: 'run_command', match: { command: '^\\s*git\\s+reset\\s+--hard' }, action: 'deny' },
  // Ask: sudo, curl mutations, wget POST, destructive disk ops.
  { tool: 'run_command', match: { command: '^\\s*sudo\\s+' }, action: 'ask' },
  { tool: 'run_command', match: { command: '\\bcurl\\b.*(-X\\s*(POST|PUT|DELETE|PATCH)|--data|--upload-file|-d\\s)' }, action: 'ask' },
  { tool: 'run_command', match: { command: '\\bwget\\b.*--post' }, action: 'ask' },
];

/**
 * The default rule set as the old Add button saved it into settings. Kept
 * verbatim so those saved copies are still recognized after the defaults
 * change.
 */
export const LEGACY_DEFAULT_PERMISSION_RULES: PermissionRule[] = [
  { tool: 'write_file', match: { path: '\\.ssh/|\\.env$|\\.env\\.|/etc/' }, action: 'deny' },
  { tool: 'run_command', match: { command: '^\\s*git\\s+push\\s+.*--force' }, action: 'deny' },
  { tool: 'run_command', match: { command: '^\\s*git\\s+reset\\s+--hard' }, action: 'deny' },
  { tool: 'run_command', match: { command: '^\\s*sudo\\s+' }, action: 'ask' },
  { tool: 'run_command', match: { command: '\\bcurl\\b.*(-X\\s*(POST|PUT|DELETE|PATCH)|--data|--upload-file|-d\\s)' }, action: 'ask' },
  { tool: 'run_command', match: { command: '\\bwget\\b.*--post' }, action: 'ask' },
];

/** Recognize only the unchanged rows created by the old Add button. */
export function isLegacyAutoAddedRuleSet(rules: unknown): rules is PermissionRule[] {
  const legacy = LEGACY_DEFAULT_PERMISSION_RULES;
  if (!Array.isArray(rules) || rules.length <= legacy.length) return false;
  const defaultRows = rules.slice(0, legacy.length);
  const addedRows = rules.slice(legacy.length);
  return JSON.stringify(defaultRows) === JSON.stringify(legacy)
    && addedRows.every((rule) => JSON.stringify(rule) === JSON.stringify({ tool: 'run_command', action: 'ask' }));
}

/** Custom rules override built-in defaults without duplicating them in settings. */
export function mergePermissionRules(customRules?: PermissionRule[]): PermissionRule[] {
  const custom = isLegacyAutoAddedRuleSet(customRules) ? [] : customRules ?? [];
  return [...custom, ...DEFAULT_PERMISSION_RULES];
}

// ─── Rule Evaluator ────────────────────────────────────────

const TOOLS_ALLOWED_WITH_MANUAL_APPROVAL = new Set([
  'read_file', 'grep_search', 'glob_search', 'list_directory',
  'read_terminal', 'read_screen', 'read_output', 'command_help', 'todo_write',
]);

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
      if (rule.action === 'allow') {
        // A rule can auto-approve an in-scope read, but cannot grant access
        // beyond the canonical workspace/sensitive-path boundary.
        if (scopeNeedsConfirmation) return { kind: 'ask' };
        return { kind: 'allow' };
      }
      if (rule.action === 'deny') {
        return { kind: 'deny', reason: `Denied by permission rule (tool=${rule.tool}).` };
      }
      return { kind: 'ask' };
    }
  }

  if (scopeNeedsConfirmation || !handler) return { kind: 'ask' };
  if (mode === 'ask' && !TOOLS_ALLOWED_WITH_MANUAL_APPROVAL.has(toolName)) return { kind: 'ask' };
  if (mode === 'extendedAccess') {
    if (toolName === 'web_search') return { kind: 'allow' };
    if (toolName === 'write_file' || toolName === 'edit_file') {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      return path && args.sudo !== true && !hasSensitivePathComponent(path)
        ? { kind: 'allow' }
        : { kind: 'ask' };
    }
  }
  return handler.requiresConfirm(args) ? { kind: 'ask' } : { kind: 'allow' };
}

/**
 * type_text / press_keys that submit a line at a shell prompt run a
 * command just like run_command, so each submitted line goes through
 * run_command's rules and danger heuristic. A submit whose line content
 * is unknown always asks. The stricter of `base` (the
 * tool's own decision) and the per-line decisions wins.
 */
export function decideTerminalSubmitPermission(
  base: PermissionDecision,
  submit: TerminalSubmit,
  pane: unknown,
  commandHandler: ToolHandler | undefined,
  mode: PermissionMode,
  rules: PermissionRule[],
  context?: ToolContext,
): PermissionDecision {
  if (base.kind !== 'allow' || submit.kind === 'none') return base;
  let result: PermissionDecision = submit.kind === 'unknown' ? { kind: 'ask' } : base;
  for (const command of submit.lines) {
    const variants = commandStartVariants(command);
    // Too many words to judge every start: do not guess, ask.
    if (!variants) result = { kind: 'ask' };
    for (const variant of variants ?? [command]) {
      const args: Record<string, unknown> = { command: variant };
      if (pane !== undefined) args.pane = pane;
      const perLine = decidePermission('run_command', args, commandHandler, mode, rules, context);
      if (perLine.kind === 'deny') {
        return { kind: 'deny', reason: `${perLine.reason} The command was submitted through terminal input: ${command}` };
      }
      if (perLine.kind === 'ask') result = perLine;
    }
  }
  return result;
}

const MAX_COMMAND_START_VARIANTS = 64;

/**
 * A line read back from the terminal starts with the shell prompt (the
 * prompt hook fires before PS1 is drawn), and where the prompt ends is
 * not known. Rules anchored at `^` must still see the command, so the
 * line is judged from every word start; the strictest result wins.
 * Returns null when the line has too many words to check this way.
 */
export function commandStartVariants(line: string): string[] | null {
  const variants = [line];
  const re = /\s+(?=\S)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    if (variants.length >= MAX_COMMAND_START_VARIANTS) return null;
    variants.push(line.slice(match.index + match[0].length));
  }
  return variants;
}

/**
 * Keystrokes that answer a program's question (Y/n, a value) are not
 * shell commands, but the question is read off the screen, which any
 * program can fake while the shell waits behind it. A submitted answer
 * that looks like a dangerous command therefore still asks.
 */
export function decidePromptAnswerPermission(
  base: PermissionDecision,
  submit: TerminalSubmit,
  commandHandler: ToolHandler | undefined,
): PermissionDecision {
  if (base.kind !== 'allow' || submit.kind === 'none' || !commandHandler) return base;
  for (const command of submit.lines) {
    if (commandHandler.requiresConfirm({ command })) return { kind: 'ask' };
  }
  return base;
}
