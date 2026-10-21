// ─── AI Agent: Audit Log ───────────────────────────────────
// Subscribes to the in-process hook system and appends one JSON
// line per significant event to the app's data directory.
//
// Intended for post-hoc debugging and security review.  Keeps
// dependencies minimal: only Tauri fs plugin, no external libs.
// Call installAuditLog() once during app startup.
//
// Lines are appended by the Rust `agent_audit_append` command, which
// serializes writes and rotates the file to agent-audit.1.jsonl once it
// passes 5 MB. On macOS the log lives at
//   ~/Library/Application Support/com.meterm.app/agent-audit.jsonl

import {
  BaseDirectory,
  writeTextFile,
  exists,
} from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { hooks } from './ai-hooks';

/** File name relative to AppData. */
const AUDIT_FILE = 'agent-audit.jsonl';

interface AuditEntry {
  ts: string;
  sessionId: string;
  kind: 'prompt' | 'tool' | 'tool_rejected' | 'session_start' | 'session_end' | 'compact';
  [k: string]: unknown;
}

async function append(entry: AuditEntry): Promise<void> {
  try {
    await invoke('agent_audit_append', { line: JSON.stringify(entry) });
  } catch {
    // Ignore filesystem failures — audit log is best effort.
  }
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

  hooks.onSessionStart(({ sessionId }) => {
    void append({
      ts: new Date().toISOString(),
      sessionId,
      kind: 'session_start',
    });
  });

  hooks.onUserPromptSubmit(({ sessionId, prompt }) => {
    void append({
      ts: new Date().toISOString(),
      sessionId,
      kind: 'prompt',
      // Clip very long prompts to keep the file readable.
      prompt: prompt.length > 2_000 ? prompt.slice(0, 2_000) + '...(truncated)' : prompt,
    });
  });

  hooks.onPostToolUse(({ sessionId, toolName, callId, args, isError, durationMs }) => {
    void append({
      ts: new Date().toISOString(),
      sessionId,
      kind: 'tool',
      tool: toolName,
      callId,
      args: safeToolArgs(toolName, args),
      isError,
      durationMs,
    });
  });

  // Denied, rejected and unconfirmed calls never reach PostToolUse, but
  // they are exactly what a security review wants to see.
  hooks.onToolRejected(({ sessionId, toolName, callId, rawArgs, reason }) => {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawArgs || '{}');
      args = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { raw: rawArgs };
    } catch {
      args = { raw: rawArgs };
    }
    void append({
      ts: new Date().toISOString(),
      sessionId,
      kind: 'tool_rejected',
      tool: toolName,
      callId,
      args: safeToolArgs(toolName, args),
      reason: reason.length > 500 ? reason.slice(0, 500) + '...(truncated)' : reason,
    });
  });

  hooks.onPreCompact(({ sessionId, reason, beforeMessageCount }) => {
    void append({
      ts: new Date().toISOString(),
      sessionId,
      kind: 'compact',
      reason,
      beforeMessageCount,
    });
  });

  hooks.onSessionEnd(({ sessionId, reason }) => {
    void append({
      ts: new Date().toISOString(),
      sessionId,
      kind: 'session_end',
      reason,
    });
  });
}

/**
 * type_text may write secrets to the PTY (the user's response to a
 * prompt, even if not literally a password). Redact the payload and log
 * only its length so an auditor can see "something was sent" without
 * exposing the contents. Everything else is clipped for size.
 */
function safeToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (toolName === 'type_text' && typeof args.text === 'string') {
    return { text: `<redacted ${args.text.length} chars>` };
  }
  return clipArgs(args);
}

function clipArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 500) {
      out[k] = v.slice(0, 500) + `...(${v.length} chars)`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── External viewer helper ───────────────────────────────

/**
 * Return the absolute path to the audit log file, creating an empty
 * file first if it does not yet exist. Used by the settings UI to
 * hand the path off to the OS default text editor via plugin-opener.
 */
export async function getAuditLogPath(): Promise<string> {
  const present = await exists(AUDIT_FILE, { baseDir: BaseDirectory.AppData });
  if (!present) {
    await writeTextFile(AUDIT_FILE, '', { baseDir: BaseDirectory.AppData });
  }
  const dir = await appDataDir();
  return await join(dir, AUDIT_FILE);
}
