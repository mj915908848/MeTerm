// ─── AI Agent: Audit Log ───────────────────────────────────
// Subscribes to the in-process hook system and appends one JSON
// line per significant event to the app's data directory.
//
// Intended for post-hoc debugging and security review. Keeps
// dependencies minimal: only Tauri fs plugin, no external libs.
// Call installAuditLog() once during app startup.
//
// We write into the one AppData file explicitly allowed by the Tauri
// filesystem capability. On macOS this resolves to
//   ~/Library/Application Support/com.meterm.app/agent-audit.jsonl

import {
  BaseDirectory,
  writeTextFile,
  readTextFile,
  exists,
} from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { hooks } from './ai-hooks';

/** File name relative to AppData. */
const AUDIT_FILE = 'agent-audit.jsonl';
/** Keep the on-disk audit log bounded even across long-running sessions. */
const MAX_AUDIT_LOG_BYTES = 1024 * 1024;

interface AuditEntry {
  ts: string;
  sessionId: string;
  kind: 'prompt' | 'tool' | 'session_start' | 'session_end' | 'compact';
  [k: string]: unknown;
}

const KNOWN_TOOLS = new Set([
  'command_help',
  'download_file',
  'glob_search',
  'grep_search',
  'list_directory',
  'press_keys',
  'read_file',
  'read_screen',
  'read_terminal',
  'run_command',
  'todo_write',
  'type_text',
  'upload_file',
  'wait_for_user_input',
  'watch_terminal',
  'web_search',
  'write_file',
]);

let appendQueue: Promise<void> = Promise.resolve();
let auditLogInitialization: Promise<boolean> | null = null;
let auditLogBytes = 0;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedString(value: unknown, maxChars = 1024): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function boundedIdentifier(value: unknown): string {
  return boundedString(value, 128) ?? '';
}

function summarizeCommand(value: unknown): string {
  if (typeof value !== 'string') return 'redacted command';
  const shape: string[] = [];
  if (value.includes('|')) shape.push('pipeline');
  if (/[<>]/.test(value)) shape.push('redirection');
  if (/(?:&&|\|\||;)/.test(value)) shape.push('chained');
  if (value.includes('\n')) shape.push('multiline');
  const details = shape.length ? `; ${shape.join(', ')}` : '';
  return `redacted command (${value.length} chars${details})`;
}

/** Only persist fields whose contents are safe for each tool. */
function safeToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case 'read_file': {
      const path = boundedString(args.path);
      return path === undefined ? {} : { path };
    }
    case 'write_file': {
      const path = boundedString(args.path);
      const contentLength = typeof args.content === 'string' ? utf8ByteLength(args.content) : undefined;
      return {
        ...(path === undefined ? {} : { path }),
        ...(contentLength === undefined ? {} : { contentLength }),
      };
    }
    case 'run_command':
      return { commandSummary: summarizeCommand(args.command) };
    case 'type_text': {
      const text = args.text;
      return {
        text: typeof text === 'string' ? `<redacted ${text.length} chars>` : '<redacted>',
      };
    }
    case 'press_keys': {
      const keys = args.keys;
      const keyCount = Array.isArray(keys)
        ? keys.length
        : typeof keys === 'string'
          ? keys.trim().split(/\s+/).filter(Boolean).length
          : 0;
      return { keyCount };
    }
    default:
      // Tool arguments and results can contain arbitrary user data or secrets.
      return { argumentCount: Object.keys(args).length };
  }
}

function safeToolName(value: unknown): string {
  return typeof value === 'string' && KNOWN_TOOLS.has(value) ? value : 'unknown';
}

function sanitizeExistingEntry(value: unknown): AuditEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== 'string') return undefined;

  const common = {
    ts: boundedString(raw.ts, 40) ?? new Date().toISOString(),
    sessionId: boundedIdentifier(raw.sessionId),
  };

  switch (raw.kind) {
    case 'session_start':
      return { ...common, kind: 'session_start' };
    case 'prompt': {
      const promptLength = typeof raw.prompt === 'string'
        ? raw.prompt.length
        : typeof raw.promptChars === 'number' && Number.isFinite(raw.promptChars)
          ? Math.max(0, raw.promptChars)
          : 0;
      return { ...common, kind: 'prompt', promptChars: promptLength };
    }
    case 'tool': {
      const tool = safeToolName(raw.tool);
      const args = raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)
        ? raw.args as Record<string, unknown>
        : {};
      return {
        ...common,
        kind: 'tool',
        tool,
        callId: boundedIdentifier(raw.callId),
        args: safeToolArgs(tool, args),
        isError: raw.isError === true,
        durationMs: typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)
          ? Math.max(0, raw.durationMs)
          : 0,
      };
    }
    case 'compact':
      return {
        ...common,
        kind: 'compact',
        ...(raw.reason === 'auto' || raw.reason === 'overflow' ? { reason: raw.reason } : {}),
        ...(typeof raw.beforeMessageCount === 'number' && Number.isFinite(raw.beforeMessageCount)
          ? { beforeMessageCount: Math.max(0, raw.beforeMessageCount) }
          : {}),
      };
    case 'session_end':
      return {
        ...common,
        kind: 'session_end',
        ...(raw.reason === 'cleared' || raw.reason === 'destroyed' ? { reason: raw.reason } : {}),
      };
    default:
      return undefined;
  }
}

/** Retain newest complete lines that fit within the byte limit. */
function keepNewestLines(contents: string): string {
  const lines = contents.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    const lineBytes = utf8ByteLength(`${line}\n`);
    // Skip pathological legacy rows, then continue with earlier valid entries.
    if (lineBytes > MAX_AUDIT_LOG_BYTES) continue;
    if (bytes + lineBytes > MAX_AUDIT_LOG_BYTES) break;
    kept.push(line);
    bytes += lineBytes;
  }
  kept.reverse();
  return kept.length ? `${kept.join('\n')}\n` : '';
}

/** Remove secrets from entries written by older versions of this logger. */
function sanitizeExistingLog(contents: string): string {
  const lines = contents.split('\n');
  const safeLines: string[] = [];
  let bytes = 0;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i]) continue;
    try {
      const entry = sanitizeExistingEntry(JSON.parse(lines[i]));
      if (!entry) continue;
      const line = JSON.stringify(entry);
      const lineBytes = utf8ByteLength(`${line}\n`);
      if (lineBytes > MAX_AUDIT_LOG_BYTES) continue;
      if (bytes + lineBytes > MAX_AUDIT_LOG_BYTES) break;
      safeLines.push(line);
      bytes += lineBytes;
    } catch {
      // Drop malformed rows instead of retaining unknown data.
    }
  }

  safeLines.reverse();
  return safeLines.length ? `${safeLines.join('\n')}\n` : '';
}

function initializeAuditLog(): Promise<boolean> {
  if (auditLogInitialization) return auditLogInitialization;
  const initialization = (async (): Promise<boolean> => {
    try {
      if (!(await exists(AUDIT_FILE, { baseDir: BaseDirectory.AppData }))) {
        auditLogBytes = 0;
        return true;
      }
      const existing = await readTextFile(AUDIT_FILE, { baseDir: BaseDirectory.AppData });
      const safeContents = sanitizeExistingLog(existing);
      await writeTextFile(AUDIT_FILE, safeContents, { baseDir: BaseDirectory.AppData });
      auditLogBytes = utf8ByteLength(safeContents);
      return true;
    } catch {
      // Do not expose or append to a legacy log that could still contain secrets.
      auditLogBytes = MAX_AUDIT_LOG_BYTES + 1;
      return false;
    }
  })();
  auditLogInitialization = initialization;
  void initialization.then((ok) => {
    if (!ok && auditLogInitialization === initialization) auditLogInitialization = null;
  });
  return initialization;
}

async function appendSerialized(entry: AuditEntry): Promise<void> {
  try {
    if (!(await initializeAuditLog())) return;
    const line = `${JSON.stringify(entry)}\n`;
    await writeTextFile(AUDIT_FILE, line, {
      baseDir: BaseDirectory.AppData,
      append: true,
    });
    auditLogBytes += utf8ByteLength(line);

    if (auditLogBytes > MAX_AUDIT_LOG_BYTES) {
      const contents = await readTextFile(AUDIT_FILE, { baseDir: BaseDirectory.AppData });
      const bounded = keepNewestLines(contents);
      await writeTextFile(AUDIT_FILE, bounded, { baseDir: BaseDirectory.AppData });
      auditLogBytes = utf8ByteLength(bounded);
    }
  } catch {
    // Ignore filesystem failures — audit log is best effort.
  }
}

function append(entry: AuditEntry): Promise<void> {
  // Keep the read/append/trim sequence serialized so concurrent hooks cannot
  // overwrite one another while enforcing the size bound.
  appendQueue = appendQueue.then(() => appendSerialized(entry), () => appendSerialized(entry));
  return appendQueue;
}

/**
 * Install the audit-log hook handlers. Idempotent:
 * calling twice is a no-op because the second call's unsubscribes
 * are never returned, but users shouldn't call this twice anyway.
 */
let installed = false;

export function installAuditLog(): void {
  if (installed) return;
  installed = true;
  // Scrub entries written by older versions before the settings UI can open
  // the log, even when no Agent session starts during this app launch.
  void initializeAuditLog();

  hooks.onSessionStart(({ sessionId }) => {
    void append({
      ts: new Date().toISOString(),
      sessionId: boundedIdentifier(sessionId),
      kind: 'session_start',
    });
  });

  hooks.onUserPromptSubmit(({ sessionId, prompt }) => {
    void append({
      ts: new Date().toISOString(),
      sessionId: boundedIdentifier(sessionId),
      kind: 'prompt',
      // Keep enough metadata to correlate prompt activity without storing text.
      promptChars: prompt.length,
    });
  });

  hooks.onPostToolUse(({ sessionId, toolName, callId, args, isError, durationMs }) => {
    const safeTool = safeToolName(toolName);
    void append({
      ts: new Date().toISOString(),
      sessionId: boundedIdentifier(sessionId),
      kind: 'tool',
      tool: safeTool,
      callId: boundedIdentifier(callId),
      args: safeToolArgs(safeTool, args),
      isError,
      durationMs,
    });
  });

  hooks.onPreCompact(({ sessionId, reason, beforeMessageCount }) => {
    void append({
      ts: new Date().toISOString(),
      sessionId: boundedIdentifier(sessionId),
      kind: 'compact',
      reason,
      beforeMessageCount,
    });
  });

  hooks.onSessionEnd(({ sessionId, reason }) => {
    void append({
      ts: new Date().toISOString(),
      sessionId: boundedIdentifier(sessionId),
      kind: 'session_end',
      reason,
    });
  });
}

// ─── External viewer helper ───────────────────────────────

/**
 * Return the absolute path to the audit log file, creating an empty
 * file first if it does not yet exist. Used by the settings UI to
 * hand the path off to the OS default text editor via plugin-opener.
 */
export async function getAuditLogPath(): Promise<string> {
  if (!(await initializeAuditLog())) {
    throw new Error('The audit log could not be safely migrated and will not be opened.');
  }
  const present = await exists(AUDIT_FILE, { baseDir: BaseDirectory.AppData });
  if (!present) {
    await writeTextFile(AUDIT_FILE, '', { baseDir: BaseDirectory.AppData });
  }
  const dir = await appDataDir();
  return await join(dir, AUDIT_FILE);
}
