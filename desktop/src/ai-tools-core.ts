// ─── AI Tools Core ─────────────────────────────────────────────
// Shared types, token budgets, danger detection, small utilities,
// ToolRegistry, and ToolContext builder.  Imported by all other
// ai-tools-* modules and re-exported from ai-tools.ts.

import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { TabManager } from './tabs';
import { getAllLeaves } from './split-pane';
import { MESSAGE_HISTORY_MAX_CHARS } from './ai-history-budget';
import { SYSTEM_CONTEXT_CHARS, DEFAULT_CONTEXT_LINES } from './ai-context-budget';
import { EXIT_CODE_UNKNOWN, exitCodeForReport } from './ai-terminal-watch-lifecycle';
import { onTerminalSessionDisposed } from './terminal-session-lifecycle';

// ─── Types ──────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; default?: unknown; minimum?: number; maximum?: number }>;
    required: string[];
  };
}

export interface ToolResult {
  toolName: string;
  result: string;
  isError: boolean;
}

/**
 * Structured tool return value for tools that need to include binary
 * attachments (e.g. read_screen capturing a PNG of the terminal).
 * A tool's execute() may return a plain string (legacy) OR an object
 * with text + images; the agent runLoop normalizes both shapes into
 * a ContentPart[]-backed tool message.
 */
export interface ToolOutputWithImages {
  /** Human-readable text summary. */
  text: string;
  /** Zero or more base64-encoded image attachments. */
  images: Array<{
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    data: string;
    label?: string;
  }>;
}

/** Descriptor for a pane inside the current tab (phase 2).
 *  Populated by buildToolContext from TabManager + TerminalRegistry. */
export interface PaneInfo {
  /** 1-based pane number as surfaced to the agent. */
  paneNumber: number;
  sessionId: string;
  isSSH: boolean;
  serverInfo: string | null;
  shellType: string;
  cwd: string;
  isDefaultTarget: boolean;
}

export interface ToolContext {
  /** The DEFAULT-target session for this run (the pane the user
   *  locked in when they hit Send). Individual tool calls may
   *  override by passing `pane: <number>`. */
  sessionId: string;
  isSSH: boolean;
  serverInfo: string | null;
  /** Detected shell type (bash, zsh, fish, powershell). Cached per session. */
  shellType: string;
  /** Current working directory (tracked via shell integration OSC 7768) */
  cwd: string;
  /**
   * Every pane of the tab that owns `sessionId`. Tools use this to
   * resolve a `pane: <number>` argument to the right underlying
   * session. Sorted by paneNumber.
   */
  panes: PaneInfo[];
  /**
   * Optional abort signal from the owning ToolAgent. Long-running tools
   * (wait_for_user_input / watch_terminal) should subscribe to this so
   * they unblock cleanly when the user cancels the agent run. Short
   * tools may ignore it — the agent loop checks `aborted` between tool
   * calls as a coarse safety net.
   */
  abortSignal?: AbortSignal;
  /**
   * Mutable handle into the agent's persistent task plan. Owned by
   * ToolAgent and forwarded into each tool batch via runLoop. Tools
   * (currently `todo_write`) read/write this to surface a structured
   * task list to both the model (via the system prompt) and the UI
   * (via the onTodoUpdate callback). Undefined when the agent is
   * driven outside the standard runLoop (tests, headless, etc).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  todoState?: import('./ai-tools-todo').TodoStateRef;
  /** Exact local read paths authorized by the permission decision. */
  approvedReadPaths?: Set<string>;
}

/** Resolve relative local tool paths against the selected terminal pane cwd. */
export function resolveLocalToolPath(path: string, cwd: string): string | null {
  const value = path.trim();
  if (!value) return null;
  if (value.startsWith('~') || value.startsWith('/') || value.startsWith('\\')
    || /^[a-z]:[\\/]/i.test(value)) return value;
  const base = cwd.trim();
  if (!base) return null;
  return `${base.replace(/[\\/]+$/, '')}/${value}`;
}

/** Build the same lexical key used by local filesystem tools for approvals. */
export function localReadApprovalKey(path: string, cwd: string): string | null {
  return resolveLocalToolPath(path, cwd);
}

/**
 * Resolve a `pane?: number` argument to the underlying target. Returns
 * either the matching PaneInfo (when the arg points at a valid pane of
 * the current tab) or an error string when the pane doesn't exist.
 * Omitting or passing a falsy value falls back to the default target.
 */
export function resolvePaneTarget(
  ctx: ToolContext,
  arg: unknown,
): { ok: true; pane: PaneInfo } | { ok: false; error: string } {
  // No argument → default target (the pane that owns ctx.sessionId).
  if (arg === undefined || arg === null || arg === '') {
    const def = ctx.panes.find((p) => p.sessionId === ctx.sessionId)
             ?? ctx.panes.find((p) => p.isDefaultTarget)
             ?? ctx.panes[0];
    if (!def) {
      return { ok: false, error: 'No panes available on the current tab.' };
    }
    return { ok: true, pane: def };
  }
  const num = typeof arg === 'number' ? arg : parseInt(String(arg), 10);
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, error: `Invalid pane number: ${String(arg)}. Expected a positive integer.` };
  }
  const match = ctx.panes.find((p) => p.paneNumber === num);
  if (!match) {
    const available = ctx.panes.map((p) => p.paneNumber).join(', ');
    return {
      ok: false,
      error: `Pane ${num} does not exist on the current tab. Available panes: ${available || '(none)'}.`,
    };
  }
  return { ok: true, pane: match };
}

export interface ToolHandler {
  definition: ToolDefinition;
  /**
   * Execute the tool. May return either:
   *   • a plain string (classic text-only result), or
   *   • a `ToolOutputWithImages` for multimodal tools like read_screen.
   * The agent loop normalizes both into the same ContentPart[] shape.
   */
  execute: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<string | ToolOutputWithImages>;
  /** Level 1: should this invocation require user confirmation? */
  requiresConfirm: (args: Record<string, unknown>) => boolean;
  /** Level 2: is this invocation extremely destructive (always confirm)? */
  isDestructive: (args: Record<string, unknown>) => boolean;
  /**
   * Whether this tool is safe to run concurrently with other
   * concurrency-safe tools in the same batch.
   *
   * - true  : read-only / side-effect-free tools (read_file, read_terminal,
   *           web_search, command_help). Multiple of these can be fanned
   *           out in parallel.
   * - false : tools that mutate the terminal, filesystem, or external
   *           state (run_command, write_file, type_text, press_keys, watch_terminal).
   *           These run serially to avoid interleaving output / races.
   *
   * The orchestrator (ai-tool-orchestrator.ts) partitions tool calls into
   * batches based on this flag.  Default: false (safe fallback).
   */
  isConcurrencySafe?: boolean;
}

// ─── Token Budget Constants ──────────────────────────────────────

export const TOKEN_BUDGET = {
  /** Terminal-context caps live in ai-context-budget.ts (imported above)
   *  so the budget maths stays testable without the terminal stack. */
  systemContextChars: SYSTEM_CONTEXT_CHARS,
  /** Max characters per tool output */
  perToolOutputChars: 4000,
  /** Max total characters in message history */
  messageHistoryMaxChars: MESSAGE_HISTORY_MAX_CHARS,
  /** Default lines for read_terminal tool */
  defaultTerminalLines: 50,
  /** Fallback pane excerpt lines when the user setting is absent. */
  defaultContextLines: DEFAULT_CONTEXT_LINES,
};

// ─── Danger Detection ────────────────────────────────────────────

const DANGER_PATTERNS = [
  /\brm\s+(-[^\s]*\s+)*-[^\s]*r/,
  /\brm\s+(-[^\s]*\s+)*\//,
  /\brm\s+-/,              // rm with any flag (e.g. rm -f, rm -i)
  /\bmkfs\b/,
  /\bdd\s+/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  /\bsystemctl\s+(stop|disable|mask)\b/,
  /\bkill\s+-9/,
  /\bkillall\b/,
  /\bpkill\b/,
  /\bchmod\s+(-[^\s]*\s+)*[0-7]*0{2}/,
  /\bchown\s+-R/,
  /\bchmod\s+-R/,
  /\b>\s*\/dev\/sd/,
  /\bdrop\s+(database|table|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\bformat\b/,
  /\bnewfs\b/,
  /\bdiskutil\s+erase/,
  /\bsudo\b/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[^\s]*f/,
  /\biptables\s+-F/,
  /\b:(){ :\|:& };:/,
];

/** Subset of DANGER_PATTERNS that are truly catastrophic */
const EXTREME_DANGER_PATTERNS = [
  /\brm\s+(-[^\s]*\s+)*-[^\s]*r[^\s]*\s+\//,  // rm -rf /
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev/,
  /\b:(){ :\|:& };:/,
  /\b>\s*\/dev\/sd/,
  /\bdiskutil\s+erase/,
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGER_PATTERNS.some((p) => p.test(cmd));
}

export function isExtremelyDangerous(cmd: string): boolean {
  return EXTREME_DANGER_PATTERNS.some((p) => p.test(cmd));
}

// ─── Utility Functions ───────────────────────────────────────────

/** Strip ANSI escape sequences from terminal output */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')   // CSI sequences (incl. private ?1h ?2004h etc.)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (BEL or ST terminated)
    .replace(/\x1b[()][A-Z0-9]/g, '')            // charset switch (e.g. \x1b(B)
    .replace(/\x1b[>=<]/g, '')                    // keypad / cursor mode switches
    .replace(/\x1b\x1b/g, '')                     // double escape
    .replace(/\r/g, '');                          // carriage return
}

/** Truncate long output, keeping head + tail */
export function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return (
    text.slice(0, half) +
    '\n\n... (truncated, showing first and last parts) ...\n\n' +
    text.slice(-half)
  );
}

/** Escape single quotes for shell string: ' → '\'' */
export function escapeShellSingle(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Exit code to report for a session's most recent command.
 *
 * `shellState.lastExitCode` is written in exactly one place — the OSC
 * 7768 handler — so it is real only while that session's shell hook is
 * alive. Without a hook nothing ever writes it and it keeps its initial
 * 0, which would report every failed command as a success; report
 * EXIT_CODE_UNKNOWN instead. Use this (not the raw field) for anything
 * the agent reads.
 */
export function exitCodeFromHook(sessionId: string): number {
  const mt = TerminalRegistry.get(sessionId);
  return exitCodeForReport(
    !!mt?.shellState.hookInjected,
    mt?.shellState.lastExitCode ?? EXIT_CODE_UNKNOWN,
  );
}

// NOTE (removed): `watchForUserInput()` used to live here — a keyboard watcher
// that was meant to abort the agent's command when the user started typing. It
// had no call site at all (only a re-export) and it keyed off
// `phase === 'agent_executing'`, a state a hookless session never leaves, so it
// could not have worked where it was needed. The behaviour it was written for
// is covered by the `userTypedRecently()` guards on the completion heuristics,
// which work with and without the hook.

// ─── Shell Type Cache ────────────────────────────────────────────

/** Cached shell type per session */
const shellTypeCache = new Map<string, string>();

export function setShellType(sessionId: string, shellType: string): void {
  shellTypeCache.set(sessionId, shellType);
}

export function getShellType(sessionId: string): string {
  return shellTypeCache.get(sessionId) ?? 'bash';
}

// The shell-type cache is keyed by session id and never had a delete, so it
// grew by one entry per session the window had ever seen. It is only a
// heuristic (OSC 7766 arrives once per shell, at hook install), so dropping an
// entry when the session goes away is safe: consumers fall back to 'bash'.
onTerminalSessionDisposed((sessionId) => {
  shellTypeCache.delete(sessionId);
});

// ─── Build Tool Context ──────────────────────────────────────────

/**
 * Build the per-tool-call context. `sessionId` is the LOCKED default
 * target for this run (set by the UI layer when the user hit Send).
 * The returned `panes` list contains every pane of the tab that owns
 * this session, letting tools resolve `pane: <n>` arguments without
 * caring about TabManager directly.
 */
export function buildToolContext(sessionId: string): ToolContext {
  const located = TabManager.locateSession(sessionId);
  const tab = located?.tab ?? null;

  const panes: PaneInfo[] = [];
  if (tab) {
    const leaves = getAllLeaves(tab.splitRoot);
    for (const leaf of leaves) {
      const info = DrawerManager.getServerInfo(leaf.sessionId);
      const mt = TerminalRegistry.get(leaf.sessionId);
      const paneNumber = tab.paneNumbers.get(leaf.id) ?? 0;
      panes.push({
        paneNumber,
        sessionId: leaf.sessionId,
        isSSH: !!info,
        serverInfo: info ? `${info.username}@${info.host}:${info.port}` : null,
        shellType: getShellType(leaf.sessionId),
        cwd: mt?.shellState.cwd ?? '',
        isDefaultTarget: leaf.sessionId === sessionId,
      });
    }
    panes.sort((a, b) => a.paneNumber - b.paneNumber);
  }

  // Degenerate fallback when the session isn't in any tab (tests,
  // headless, edge cases).
  if (panes.length === 0) {
    const info = DrawerManager.getServerInfo(sessionId);
    const mt = TerminalRegistry.get(sessionId);
    panes.push({
      paneNumber: 1,
      sessionId,
      isSSH: !!info,
      serverInfo: info ? `${info.username}@${info.host}:${info.port}` : null,
      shellType: getShellType(sessionId),
      cwd: mt?.shellState.cwd ?? '',
      isDefaultTarget: true,
    });
  }

  const defaultPane = panes.find((p) => p.isDefaultTarget) ?? panes[0];

  return {
    sessionId: defaultPane.sessionId,
    isSSH: defaultPane.isSSH,
    serverInfo: defaultPane.serverInfo,
    shellType: defaultPane.shellType,
    cwd: defaultPane.cwd,
    panes,
    approvedReadPaths: new Set<string>(),
  };
}

// ─── Tool Registry ───────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    this.tools.set(handler.definition.name, handler);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolHandler | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((h) => h.definition);
  }

  /**
   * Determine whether a tool invocation needs user confirmation
   * based on the CURRENT trust level (read at call time).
   */
  shouldConfirm(toolName: string, args: Record<string, unknown>, trustLevel: number): boolean {
    const handler = this.tools.get(toolName);
    if (!handler) return true; // unknown tool → always confirm

    switch (trustLevel) {
      case 0:
        return true; // Level 0: ALL operations need confirmation
      case 1:
        return handler.requiresConfirm(args); // Level 1: dangerous ops only
      case 2:
        return handler.isDestructive(args); // Level 2: only catastrophic
      default:
        return true;
    }
  }
}
