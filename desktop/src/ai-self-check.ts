// ─── AI Agent: self-check before the final reply ────────────────
// Models tend to announce "done" right after the last change, without
// looking at whether it worked, or with steps of their own plan still
// open. When a run ends like that, the agent loop sends ONE note back
// asking the model to verify and finish, then lets it reply again.
//
// Import-free so node tests can load it.

/** Tools whose confirmed calls change something on the machine. */
const CHANGING_TOOLS = new Set(['run_command', 'write_file', 'edit_file', 'upload_file']);

export interface SelfCheckState {
  /** The most recent successful tool call changed something, and nothing checked it since. */
  unverifiedChange: boolean;
  /** The note was already sent this run. */
  nudged: boolean;
}

export function newSelfCheckState(): SelfCheckState {
  return { unverifiedChange: false, nudged: false };
}

/**
 * Record a finished tool call. `changes` is whether the call needed
 * confirmation under the "safe" permission mode (read-only commands
 * do not), which is the codebase's existing read/write classifier.
 */
export function noteToolCall(state: SelfCheckState, toolName: string, changes: boolean, isError: boolean): void {
  if (isError) return;
  if (CHANGING_TOOLS.has(toolName) && changes) state.unverifiedChange = true;
  else if (toolName === 'run_command' || toolName === 'read_file' || toolName === 'read_terminal'
    || toolName === 'read_output' || toolName === 'read_screen' || toolName === 'watch_terminal') {
    state.unverifiedChange = false;
  }
}

/** A reply that ends by asking the user something is waiting on them, not finishing. */
function asksUser(reply: string): boolean {
  return /[?？]\s*$/.test(reply.trim());
}

/**
 * The note to send back instead of ending the run, or null to end it.
 * `openSteps` are the plan items not yet completed.
 */
export function selfCheckNote(
  state: SelfCheckState,
  openSteps: string[],
  reply: string,
  canContinue: boolean,
): string | null {
  if (state.nudged || !canContinue || asksUser(reply)) return null;
  if (openSteps.length === 0 && !state.unverifiedChange) return null;
  const parts = ['[Automatic self-check before finishing — not written by the user]'];
  if (openSteps.length > 0) {
    parts.push(`Your plan still has unfinished steps:\n${openSteps.map((s) => `  - ${s}`).join('\n')}\nFinish them, or mark them done / drop them with todo_write if they are no longer needed.`);
  }
  if (state.unverifiedChange) {
    parts.push('Your last change has not been checked. Verify it with one read-only command that proves the result (e.g. a config test like `nginx -t`, `systemctl status <svc>`, `curl -I <url>`, re-running the command that failed, or reading back the edited lines).');
  }
  parts.push('If something fails, fix it. When everything is verified, give the final reply and say what you checked. If there is nothing to verify, just repeat your final reply briefly.');
  return parts.join('\n\n');
}
