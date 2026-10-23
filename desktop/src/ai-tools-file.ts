// ─── AI Tools: File Operations ──────────────────────────────────
// read_file, write_file, edit_file — supports both local and SSH remote paths.
//
// Local files go through dedicated Rust commands (`agent_read_file`,
// `agent_write_file`) that use std::fs directly. We DO NOT use the
// `@tauri-apps/plugin-fs` API for the agent because that plugin is
// scoped to AppData via `fs:scope-appdata-recursive`, which would
// reject any path outside the app data directory with a confusing
// "path not allowed in scope" error (which manifested as "undefined"
// when the TS catch block tried to read `.message` off the rejection
// value, since Tauri's plugin sometimes throws strings instead of
// Error objects).
//
// Remote (SSH) files go through the session's SFTP client
// (`sftp_read_file` / `sftp_write_file` / `sftp_edit_file`), so nothing is
// typed into the user's shell. When SFTP is unavailable (subsystem
// disabled, `~user` paths) read/write fall back to `sed` / `printf` over
// the live PTY via `executeViaTerminal`.

import { invoke } from '@tauri-apps/api/core';
import { resolveLocalToolPath, ToolHandler } from './ai-tools-core';
import { executeViaTerminal } from './ai-tools-shell';
import { hasSensitivePathComponent } from './ai-permission-rules';
import { quoteRemotePath, resolveSftpPath } from './ai-remote-path';
import {
  commitSucceeded, describeSudoFailure, parseTempPath, removeTempCommand,
  sudoCommitCommand, sudoStageCommand, tempFileCommand,
} from './ai-sudo-file';

interface AgentReadResult {
  content: string | null;
  size: number;
  is_binary: boolean;
  too_large: boolean;
  /** True when maxLines cut the content short. */
  truncated?: boolean;
  /** Total line count, when the whole file was scanned. */
  total_lines?: number | null;
}

/** Format any thrown value into a human-readable error message. */
function fmtError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') return m;
    try { return JSON.stringify(e); } catch { return String(e); }
  }
  return String(e);
}

/** Default number of lines read_file returns. */
const READ_DEFAULT_LINES = 200;
/** Most characters one read_file result returns, whatever the line count. */
const READ_MAX_CHARS = 16000;

/** True when an SFTP command failed because the session has no SFTP. */
function sftpUnavailable(e: unknown): boolean {
  return /SFTP not available|session not found/i.test(fmtError(e));
}

/** Render an AgentReadResult (local or SFTP) as the read_file tool result. */
function formatReadResult(result: AgentReadResult, startLine: number, path: string): string {
  if (result.too_large) {
    return `File too large (${(result.size / 1024 / 1024).toFixed(1)} MB). Use run_command with head/tail/grep to read specific parts.`;
  }
  if (result.is_binary) {
    return `This appears to be a binary file (${result.size} bytes). Cannot display content. Use run_command with xxd / file / strings to inspect.`;
  }
  let content = result.content ?? '';
  let truncated = !!result.truncated;
  // The line limit alone does not bound the size: minified code or a log
  // with very long lines can be megabytes in 200 lines. Keep whole lines
  // up to READ_MAX_CHARS; a single longer line is cut and marked.
  let cutLine = false;
  if (content.length > READ_MAX_CHARS) {
    const lastBreak = content.lastIndexOf('\n', READ_MAX_CHARS);
    if (lastBreak > 0) {
      content = content.slice(0, lastBreak);
    } else {
      content = content.slice(0, READ_MAX_CHARS);
      cutLine = true;
    }
    truncated = true;
  }
  if (!truncated && startLine <= 1) return content;
  const shown = content ? content.split('\n').length : 0;
  const total = result.total_lines ? ` of ${result.total_lines}` : '';
  if (shown === 0) {
    return `--- ${path}: no lines at or after line ${startLine}${total ? ` (file has${total.replace(' of', '')} lines)` : ''}. ---`;
  }
  const end = startLine + shown - 1;
  if (cutLine) {
    return `${content}…\n\n--- Line ${startLine} is longer than ${READ_MAX_CHARS} characters and was cut. Use run_command with cut -c / head -c / jq / grep -o to read parts of it. Next line: offset=${startLine + 1}. ---`;
  }
  const more = truncated
    ? ` To read further, call read_file again with offset=${end + 1}.`
    : '';
  return `${content}\n\n--- Showing lines ${startLine}-${end}${total} (${result.size} bytes total).${more} ---`;
}

// ─── sudo (SSH only) ────────────────────────────────────────────
// See ai-sudo-file.ts: root-owned files are staged through a temp file
// that SFTP can reach as the login user.

const SUDO_PARAM = {
  type: 'boolean',
  description: 'SSH sessions only: access the file as root via sudo, for files the login user cannot read or write (e.g. under /etc). Uses sudo -n, so if sudo needs a password the tool says so and you must have the user run `sudo -v` first.',
  default: false,
} as const;

type ToolCtx = Parameters<ToolHandler['execute']>[1];

function wantsSudo(args: Record<string, unknown>): boolean {
  return args.sudo === true;
}

function sudoUnsupported(ctx: ToolCtx): string | null {
  return ctx.isSSH ? null : 'Error: sudo=true is only supported on SSH sessions. Locally, use run_command with sudo.';
}

/**
 * Run `work` against a temp file staged for `path`, then clean up. With
 * `stage` the temp starts as a root-read copy of the file; without it the
 * temp starts empty. `commit` writes the temp back over the file as root.
 */
async function withSudoTemp<T>(
  ctx: ToolCtx,
  path: string,
  opts: { stage: boolean; commit: boolean; mkdirs?: boolean },
  work: (temp: string) => Promise<T>,
): Promise<T | string> {
  const cmd = opts.stage ? sudoStageCommand(quoteRemotePath(path)) : tempFileCommand();
  const out = await executeViaTerminal(ctx.sessionId, cmd, 20, ctx.shellType);
  const temp = parseTempPath(out);
  if (!temp) return `Error: could not read ${path} with sudo: ${describeSudoFailure(out)}`;
  let result: T;
  try {
    result = await work(temp);
  } catch (e) {
    await executeViaTerminal(ctx.sessionId, removeTempCommand(temp), 10, ctx.shellType).catch(() => '');
    throw e;
  }
  if (!opts.commit) {
    await executeViaTerminal(ctx.sessionId, removeTempCommand(temp), 10, ctx.shellType).catch(() => '');
    return result;
  }
  const done = await executeViaTerminal(
    ctx.sessionId, sudoCommitCommand(quoteRemotePath(path), temp, opts.mkdirs ?? false), 20, ctx.shellType,
  );
  if (!commitSucceeded(done)) return `Error: could not write ${path} with sudo: ${describeSudoFailure(done)}`;
  return result;
}

// ─── read_file ──────────────────────────────────────────────────

export function createReadFileTool(): ToolHandler {
  return {
    definition: {
      name: 'read_file',
      description:
        'Read a text file. Returns up to `limit` lines starting at line `offset` (1-based); a footer says which lines were shown and how to read on. Supports absolute paths, ~/-prefixed paths, paths relative to the pane cwd, and (on local sessions) Windows drive paths. On SSH sessions the file is read over SFTP, not typed into the terminal.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute, ~/-prefixed, or cwd-relative file path' },
          offset: {
            type: 'number',
            description: 'First line to return, 1-based (default: 1)',
            default: 1,
          },
          limit: {
            type: 'number',
            description: `Maximum number of lines to return (default: ${READ_DEFAULT_LINES})`,
            default: READ_DEFAULT_LINES,
          },
          sudo: SUDO_PARAM,
        },
        required: ['path'],
      },
    },
    // read_file only reads → safe to parallelize across multiple files.
    isConcurrencySafe: true,
    // A root read can expose anything on the host, so it is always confirmed.
    requiresConfirm: (args) => wantsSudo(args),
    isDestructive: (args) => wantsSudo(args),

    async execute(args, ctx): Promise<string> {
      const path = String(args.path ?? '').trim();
      if (!path) {
        return 'Error: read_file requires a non-empty "path" argument.';
      }
      // `maxLines` is the old name of `limit`; restored conversations still use it.
      const requestedLimit = args.limit ?? args.maxLines;
      if (requestedLimit !== undefined &&
          (typeof requestedLimit !== 'number' || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1)) {
        return 'Error: read_file limit must be a positive integer.';
      }
      const requestedOffset = args.offset;
      if (requestedOffset !== undefined &&
          (typeof requestedOffset !== 'number' || !Number.isSafeInteger(requestedOffset) || requestedOffset < 1)) {
        return 'Error: read_file offset must be a positive integer (1 = first line).';
      }
      const maxLines = requestedLimit ?? READ_DEFAULT_LINES;
      const startLine = requestedOffset ?? 1;

      if (wantsSudo(args)) {
        const unsupported = sudoUnsupported(ctx);
        if (unsupported) return unsupported;
        try {
          return await withSudoTemp(ctx, path, { stage: true, commit: false }, async (temp) => {
            const result = await invoke<AgentReadResult>('sftp_read_file', {
              sessionId: ctx.sessionId, path: temp, startLine, maxLines,
            });
            return formatReadResult(result, startLine, path);
          });
        } catch (e) {
          return `Error reading file: ${fmtError(e)}`;
        }
      }

      if (ctx.isSSH) {
        const sftpPath = resolveSftpPath(path, ctx.cwd ?? '');
        if (sftpPath) {
          try {
            const result = await invoke<AgentReadResult>('sftp_read_file', {
              sessionId: ctx.sessionId,
              path: sftpPath,
              startLine,
              maxLines,
            });
            return formatReadResult(result, startLine, path);
          } catch (e) {
            if (!sftpUnavailable(e)) return `Error reading file: ${fmtError(e)}`;
          }
        }
        // No SFTP: read via terminal command (see quoteRemotePath).
        const cmd = `sed -n '${startLine},${startLine + maxLines - 1}p' ${quoteRemotePath(path)} 2>&1`;
        try {
          return await executeViaTerminal(ctx.sessionId, cmd, 15, ctx.shellType);
        } catch (e) {
          return `Error reading file: ${fmtError(e)}`;
        }
      }

      // Local: invoke the Rust command (bypasses Tauri fs scope).
      const localPath = resolveLocalToolPath(path, ctx.cwd);
      if (!localPath) return 'Error: cannot resolve a relative path because the terminal working directory is unavailable.';
      try {
        const result = await invoke<AgentReadResult>('agent_read_file', {
          path: localPath,
          // Only the requested lines are kept; the rest of the file
          // (up to 10 MB) is scanned just to count its lines.
          maxBytes: 10 * 1024 * 1024,
          maxLines,
          startLine,
          workspaceRoot: ctx.cwd,
          approvedCanonicalPath: ctx.approvedReadPaths?.get(localPath) ?? null,
        });
        return formatReadResult(result, startLine, path);
      } catch (e) {
        return `Error reading file: ${fmtError(e)}`;
      }
    },
  };
}

// ─── write_file ─────────────────────────────────────────────────

export function createWriteFileTool(): ToolHandler {
  return {
    definition: {
      name: 'write_file',
      description:
        'Create a file, or replace a file\'s ENTIRE content. To change part of an existing file use edit_file instead — rewriting a file you have only partly read loses the rest. Parent directories are created automatically. Supports absolute, ~/-prefixed and cwd-relative paths. On SSH sessions the file is written over SFTP.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute, ~/-prefixed, or cwd-relative file path' },
          content: { type: 'string', description: 'Content to write (UTF-8)' },
          sudo: SUDO_PARAM,
        },
        required: ['path', 'content'],
      },
    },
    // write_file mutates filesystem → never concurrent.
    isConcurrencySafe: false,
    // Level 1: write_file always needs confirmation
    requiresConfirm: () => true,
    // Full-auto skips confirmation, except for credential locations
    // (~/.ssh, .env, keys, …) where a silent write could plant access.
    isDestructive: (args) => wantsSudo(args) || hasSensitivePathComponent(String(args.path ?? '')),

    async execute(args, ctx): Promise<string> {
      const filePath = String(args.path ?? '').trim();
      if (!filePath) {
        return 'Error: write_file requires a non-empty "path" argument.';
      }
      const content = typeof args.content === 'string' ? args.content : '';

      // Size guard
      if (content.length > 100 * 1024) {
        return `Content too large (${(content.length / 1024).toFixed(1)} KB). Break into smaller files or use run_command to write.`;
      }

      if (wantsSudo(args)) {
        const unsupported = sudoUnsupported(ctx);
        if (unsupported) return unsupported;
        try {
          return await withSudoTemp(ctx, filePath, { stage: false, commit: true, mkdirs: true }, async (temp) => {
            const written = await invoke<number>('sftp_write_file', { sessionId: ctx.sessionId, path: temp, content });
            return `File written successfully with sudo: ${filePath} (${written} bytes)`;
          });
        } catch (e) {
          return `Error writing file: ${fmtError(e)}`;
        }
      }

      if (ctx.isSSH) {
        const sftpPath = resolveSftpPath(filePath, ctx.cwd ?? '');
        if (sftpPath) {
          try {
            const written = await invoke<number>('sftp_write_file', {
              sessionId: ctx.sessionId,
              path: sftpPath,
              content,
            });
            return `File written successfully: ${filePath} (${written} bytes)`;
          } catch (e) {
            if (!sftpUnavailable(e)) return `Error writing file: ${fmtError(e)}`;
          }
        }
        // No SFTP: a quoted printf argument preserves the exact text,
        // including whether the final line has a newline. Heredocs always
        // add a final newline.
        const safePath = quoteRemotePath(filePath);
        const safeContent = content.replace(/'/g, `'\\''`);
        const dirCmd = `mkdir -p "$(dirname ${safePath})"`;
        const writeCmd = `${dirCmd} && printf '%s' '${safeContent}' > ${safePath}`;
        try {
          const result = await executeViaTerminal(ctx.sessionId, writeCmd, 15, ctx.shellType);
          // Heuristic error sniff — anything containing the word
          // "denied" or matching common error keywords on the LAST
          // non-empty line is treated as failure (avoids false
          // positives from filenames that contain "error").
          const lastLine = result.trim().split('\n').filter(Boolean).pop() ?? '';
          if (/permission denied|no such file|cannot create|read-only file system|operation not permitted/i.test(lastLine)) {
            return `Error writing file: ${lastLine}`;
          }
          return `File written successfully: ${filePath} (${content.length} bytes)`;
        } catch (e) {
          return `Error writing file: ${fmtError(e)}`;
        }
      }

      // Local: invoke the Rust command (bypasses Tauri fs scope).
      const localPath = resolveLocalToolPath(filePath, ctx.cwd);
      if (!localPath) return 'Error: cannot resolve a relative path because the terminal working directory is unavailable.';
      try {
        const written = await invoke<number>('agent_write_file', {
          path: localPath,
          content,
        });
        return `File written successfully: ${filePath} (${written} bytes)`;
      } catch (e) {
        return `Error writing file: ${fmtError(e)}`;
      }
    },
  };
}

// ─── edit_file ──────────────────────────────────────────────────

interface AgentEditResult {
  replacements: number;
  first_line: number;
  size: number;
}

export function createEditFileTool(): ToolHandler {
  return {
    definition: {
      name: 'edit_file',
      description:
        'Change part of an existing text file by exact string replacement: old_string is replaced with new_string. old_string must match the file exactly (whitespace and indentation included) and occur exactly once — include a few surrounding lines to make it unique, or set replace_all to change every occurrence. Read the relevant part of the file with read_file first. The rest of the file is untouched, so this is the safe way to edit config files. On SSH sessions the edit goes over SFTP as the login user; for files that need root (e.g. under /etc), set sudo=true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute, ~/-prefixed, or cwd-relative file path' },
          old_string: { type: 'string', description: 'Exact text to replace (must be non-empty)' },
          new_string: { type: 'string', description: 'Replacement text (may be empty to delete)' },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence instead of requiring a unique match (default: false)',
            default: false,
          },
          sudo: SUDO_PARAM,
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    isConcurrencySafe: false,
    requiresConfirm: () => true,
    isDestructive: (args) => wantsSudo(args) || hasSensitivePathComponent(String(args.path ?? '')),

    async execute(args, ctx): Promise<string> {
      const filePath = String(args.path ?? '').trim();
      if (!filePath) return 'Error: edit_file requires a non-empty "path" argument.';
      if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
        return 'Error: edit_file requires string "old_string" and "new_string" arguments.';
      }
      const params = {
        oldString: args.old_string,
        newString: args.new_string,
        replaceAll: args.replace_all === true,
      };

      let result: AgentEditResult;
      try {
        if (wantsSudo(args)) {
          const unsupported = sudoUnsupported(ctx);
          if (unsupported) return unsupported;
          const edited = await withSudoTemp(ctx, filePath, { stage: true, commit: true }, (temp) =>
            invoke<AgentEditResult>('sftp_edit_file', { sessionId: ctx.sessionId, path: temp, ...params }));
          if (typeof edited === 'string') return edited;
          result = edited;
        } else if (ctx.isSSH) {
          const sftpPath = resolveSftpPath(filePath, ctx.cwd ?? '');
          if (!sftpPath) {
            return 'Error: edit_file cannot resolve this remote path. Use an absolute path, or read_file + write_file.';
          }
          result = await invoke<AgentEditResult>('sftp_edit_file', {
            sessionId: ctx.sessionId,
            path: sftpPath,
            ...params,
          });
        } else {
          const localPath = resolveLocalToolPath(filePath, ctx.cwd);
          if (!localPath) return 'Error: cannot resolve a relative path because the terminal working directory is unavailable.';
          result = await invoke<AgentEditResult>('agent_edit_file', { path: localPath, ...params });
        }
      } catch (e) {
        if (ctx.isSSH && sftpUnavailable(e)) {
          return 'Error: SFTP is not available on this session, so edit_file cannot run. Use read_file + write_file, or sed via run_command.';
        }
        return `Error editing file: ${fmtError(e)}`;
      }
      const what = result.replacements === 1 ? '1 replacement' : `${result.replacements} replacements`;
      return `File edited: ${filePath} (${what}, first at line ${result.first_line}; ${result.size} bytes now).`;
    },
  };
}
