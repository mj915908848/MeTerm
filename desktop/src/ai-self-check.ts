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

// Commands that change the machine. run_command also asks for
// confirmation on read-only commands it cannot prove safe (compound
// lines, sudo), so the self-check looks at the command itself.
const MUTATING_COMMAND = new RegExp([
  String.raw`\b(systemctl|service|rc-service)\b[^;&|]*\b(start|stop|restart|reload|enable|disable|mask|unmask|kill|daemon-reload)\b`,
  String.raw`\b(apt|apt-get|yum|dnf|zypper|pacman|apk|brew|snap)\b[^;&|]*\b(install|remove|purge|upgrade|update|add|del)\b`,
  String.raw`\bpacman\s+-[SRU]`,
  String.raw`\b(pip3?|npm|pnpm|yarn|gem|cargo)\b[^;&|]*\b(install|uninstall|add|remove)\b`,
  String.raw`\b(docker|podman)\b[^;&|]*\b(run|start|stop|restart|rm|rmi|kill|pull|create|prune|up|down)\b`,
  String.raw`\bkubectl\b[^;&|]*\b(apply|delete|create|patch|edit|scale|rollout|set|label|annotate|drain|cordon)\b`,
  String.raw`\bgit\b[^;&|]*\b(commit|push|pull|merge|rebase|reset|checkout|switch|stash|clean)\b`,
  String.raw`(^|[;&|(]\s*|\bsudo\s+(-\S+\s+)*)(rm|rmdir|mv|cp|ln|chmod|chown|chgrp|mkdir|touch|truncate|dd|kill|pkill|killall|reboot|shutdown|useradd|userdel|usermod|passwd|crontab|mount|umount|iptables|ufw|firewall-cmd|nft|sysctl|tee|install)\b`,
  String.raw`\bsed\b[^;&|]*\s-i`,
  String.raw`\bsysctl\s+-w\b`,
].join('|'));

/** Whether a shell command line looks like it changes something. Heuristic. */
export function commandLooksMutating(cmd: string): boolean {
  if (MUTATING_COMMAND.test(cmd)) return true;
  // A redirect into a file, except /dev/null and fd duplication (2>&1).
  const withoutSafe = cmd.replace(/\d*>>?\s*(\/dev\/null|&\d|&-)/g, '');
  return /(^|[^<>=-])>>?\s*[^\s&>]/.test(withoutSafe.replace(/'[^']*'|"[^"]*"/g, "''"));
}

/**
 * Plan steps that are really unfinished once this reply is shown.
 * When only one step is open, the reply is that step (usually "report
 * the findings"), the same rule TodoState.settleAfterReply uses.
 */
export function stepsLeftAfterReply(items: Array<{ content: string; status: string }>): string[] {
  const open = items.filter((it) => it.status !== 'completed');
  return open.length <= 1 ? [] : open.map((it) => it.content);
}

/** A reply that ends by asking the user something is waiting on them, not finishing. */
function asksUser(reply: string): boolean {
  return /[?？]\s*$/.test(reply.trim());
}

/**
 * The note to send back instead of ending the run, or null to end it.
 * `openSteps` are the plan items still open (stepsLeftAfterReply).
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
  parts.push('If something fails, fix it and then give the final reply. If everything checks out, the user already has your reply above: answer with ONE short line saying what you checked and that the result stands. Do not repeat the report, and do not mention this self-check.');
  return parts.join('\n\n');
}
