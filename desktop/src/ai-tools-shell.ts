// ─── AI Tools Shell Integration & Command Executor ────────────
// Handles shell hook injection (OSC 7768), command execution via
// shell integration or OSC 7766 markers, output capture & cleanup.

import { TerminalRegistry } from './terminal';
import { invoke } from '@tauri-apps/api/core';
// NOTE: The previous implementation used `invoke('inject_osc_marker')`
// to fake a completion marker after 1.5s of silence.  That hack caused
// false positives for interactive commands (ssh/sudo password prompts,
// vim/top TUIs) — the wait would resolve while the process was still
// blocking the PTY.  We now detect interactive state via prompt
// patterns and alt-screen flags instead.  See ai-tools-prompt-detect.ts.
import { loadSettings } from './themes';
import {
  escapeShellSingle,
  exitCodeFromHook,
  setShellType,
  stripAnsi,
  truncateOutput,
  TOKEN_BUDGET,
} from './ai-tools-core';
import {
  EXIT_CODE_UNKNOWN,
  WATCH_DETECT_TAIL_CHARS,
  shouldCompleteFromPromptTail,
  userTypedRecently,
} from './ai-terminal-watch-lifecycle';
import {
  detectInteractiveState,
  describeState,
  endsWithShellPrompt,
  type InteractiveState,
  type PromptInfo,
} from './ai-tools-prompt-detect';
import { onTerminalSessionDisposed } from './terminal-session-lifecycle';

// ─── Per-session PTY lock ─────────────────────────────────────────
// The orchestrator parallelizes any tools whose handler is marked
// `isConcurrencySafe: true` (read_file, list_directory, glob_search,
// grep_search, …). That parallelism is fine when the work is local
// (the Rust commands are independent) but it would CORRUPT a shared
// PTY if two of those tools targeted the same SSH session — both
// would push commands into the same pty stream and the captured
// outputs would interleave.
//
// We solve this with a session-keyed promise queue: any caller that
// touches a session's PTY (sends input, observes output, captures
// command results) wraps its critical section in `withSessionPtyLock`,
// and the lock guarantees those critical sections execute serially
// PER SESSION while still allowing different sessions to run in
// parallel and allowing pure buffer reads (read_terminal, read_screen)
// to bypass entirely.
//
// The lock is intentionally cooperative — it only protects callers
// that opt in. The runLoop's orchestrator stays unchanged: tools are
// still grouped by `isConcurrencySafe`, and parallel batches still
// race on the JS event loop. The lock just ensures that when two
// "concurrency-safe" tools happen to land on the same session, the
// second one waits for the first to finish its PTY round-trip.

const sessionPtyTails = new Map<string, Promise<unknown>>();

/**
 * Serialize PTY interactions per session. Wrap any function that
 * sends input to or observes output from a specific session's PTY
 * in this helper. Calls on different sessions never block each
 * other; calls on the same session execute strictly in arrival
 * order.
 *
 * Errors from `fn` propagate to the caller normally — they do NOT
 * poison the queue, so a failed read_file does not block subsequent
 * tools on the same session.
 */
export function withSessionPtyLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sessionPtyTails.get(sessionId) ?? Promise.resolve();
  // Chain regardless of prev outcome (success → fn, failure → fn).
  // The shared tail is .catch'd before being stored so unhandled
  // rejections from earlier critical sections don't bubble out of
  // the queue. Map size is bounded by the number of live sessions,
  // not the number of calls — each session keeps exactly one tail
  // entry that is overwritten on every new acquire.
  const next = prev.then(fn, fn);
  sessionPtyTails.set(sessionId, next.catch(() => undefined));
  return next;
}

// ─── Shell State Machine ──────────────────────────────────────────
// The prompt hook (__meterm_precmd) sends OSC 7768 with exit code + CWD
// before each prompt. This drives the state machine:
//   unknown → ready (first OSC 7768) → agent_executing → ready (next OSC 7768)
//
// It is a HOOK-ONLY machine: nothing else can advance or reset it, so a
// hookless session parks at whatever it last was. That is why every reader of
// `phase` in this codebase is gated on `hookInjected` and why the hookless
// completion path below reads the screen tail instead — see ShellPhase in
// terminal-types.ts.

/**
 * Build the one-line precmd hook script for a given shell type.
 * Emits `OSC 7768;EXIT_CODE;CWD;LAST_CMD;DURATION_MS` before each prompt.
 *
 * The trailing `duration_ms` is **not** cosmetic: the Rust side turns
 * "duration ≥ 30s" into the "long command finished" push
 * (`server/session/mod.rs::notify_events_to_publish`). The OSC filter parses
 * the field as optional so 3-field hooks keep working — which is precisely how
 * this one shipped without it and silently disabled the feature. For that
 * reason the field is locked down by `tests/shell-hook-duration.test.mts`.
 *
 * Timers must be installed *before* the command runs, hence the preexec tweak
 * per shell: zsh `add-zsh-hook preexec` (needs `zmodload zsh/datetime` for
 * `EPOCHREALTIME`), bash a `DEBUG` trap (bash's `$(( ))` is integer-only, so
 * `EPOCHREALTIME` is split into seconds/microseconds and each half prefixed
 * with `10#` — otherwise a fraction like `012345` would be read as *octal*).
 *
 * Installing it must not cost the user something they already had: bash allows
 * exactly one `DEBUG` trap, so ours is installed only when the shell has none
 * (see the bash branch). A `duration_ms` of 0 is cheaper than deleting a remote
 * server's `bash-preexec` / audit hook — and cheaper than silently dropping
 * `PROMPT_COMMAND` entries, which is why the extension below follows the shape
 * the variable already has (bash 5.1+ arrays included).
 *
 * `fish` and `powershell` deliberately still emit 3 fields: a syntax error in an
 * injected hook is *masked* (the 7766 detect marker fires before the `eval`, so
 * `hookInjected` would flip true while the hook is dead), so the extra field is
 * only worth adding where the hook can be *run*, not merely read. `fish` is now
 * run for real by `tests/shell-hook-injection.test.mts` whenever a `fish` binary
 * is on PATH — which is why the injected line is kept free of anything fish
 * cannot parse (see `hostGuardCommand`) — but that binary is absent in CI, so
 * treat the fish path as verified-where-available rather than covered. `pwsh`
 * is neither run nor verified anywhere.
 */
function buildShellHook(shellType: string): string {
  switch (shellType) {
    case 'zsh':
      return [
        `__meterm_cmd_start='';__meterm_cmd_running=0;`,
        `__meterm_preexec(){ __meterm_cmd_running=1;`,
        `if [ -n "\${EPOCHREALTIME:-}" ];then __meterm_cmd_start="$EPOCHREALTIME";else __meterm_cmd_start="$SECONDS";fi; };`,
        `__meterm_precmd(){ local e=$?;local c;local dur=0;`,
        `if [ -z "$__meterm_hook_ready" ];then export __meterm_hook_ready=1;c='';`,
        `else c=$(fc -ln -1 2>/dev/null);`,
        `if [ "$__meterm_cmd_running" = 1 ]&&[ -n "$__meterm_cmd_start" ]&&[ -n "\${EPOCHREALTIME:-}" ];then dur=$(( (EPOCHREALTIME - __meterm_cmd_start) * 1000 ));dur=\${dur%%.*};`,
        `case "$dur" in ''|*[!0-9-]*) dur=0;; esac;fi;fi;`,
        `__meterm_cmd_running=0;`,
        `printf '\\033]7768;%d;%s;%s;%d\\007' "$e" "$PWD" "$c" "$dur"; };`,
        `zmodload zsh/datetime 2>/dev/null;`,
        `autoload -Uz add-zsh-hook 2>/dev/null&&{ add-zsh-hook preexec __meterm_preexec; add-zsh-hook precmd __meterm_precmd; }`,
      ].join('');
    case 'fish':
      return [
        `function __meterm_postcmd --on-event fish_postexec;`,
        `if not set -q __meterm_hook_ready;set -gx __meterm_hook_ready 1;`,
        `printf '\\033]7768;%d;%s;\\007' $status "$PWD";`,
        `else;`,
        `printf '\\033]7768;%d;%s;%s\\007' $status "$PWD" "$argv";`,
        `end;`,
        `end`,
      ].join('');
    case 'powershell':
      return [
        `function prompt {`,
        `$e=$LASTEXITCODE;`,
        `if (-not $env:__meterm_hook_ready){$env:__meterm_hook_ready='1';$c=''}`,
        `else{$c=(Get-History -Count 1).CommandLine};`,
        `[Console]::Write("$([char]0x1b)]7768;$e;$(Get-Location);$c$([char]7)");`,
        `return "PS> "`,
        `}`,
      ].join('');
    default: // bash
      return [
        `__meterm_cmd_start='';__meterm_cmd_running=0;__meterm_in_prompt=0;`,
        `__meterm_preexec(){ [ -n "\${COMP_LINE:-}" ]&&return;`,
        `case "\${BASH_COMMAND:-}" in __meterm_precmd*) return;; esac;`,
        `[ "\${__meterm_in_prompt:-0}" = 1 ]&&return;`,
        `[ "\${__meterm_cmd_running:-0}" = 1 ]&&return;`,
        `__meterm_cmd_running=1;`,
        `if [ -n "\${EPOCHREALTIME:-}" ];then __meterm_cmd_start="$EPOCHREALTIME";else __meterm_cmd_start="\${EPOCHSECONDS:-$SECONDS}";fi; };`,
        `__meterm_precmd(){ local e=$?;local c;local dur=0;__meterm_in_prompt=1;`,
        `if [ -z "$__meterm_hook_ready" ];then export __meterm_hook_ready=1;c='';`,
        `else c=$(fc -ln -1 2>/dev/null);`,
        `if [ "\${__meterm_cmd_running:-0}" = 1 ]&&[ -n "\${__meterm_cmd_start:-}" ];then if [ -n "\${EPOCHREALTIME:-}" ];then local __s_sec=\${__meterm_cmd_start%.*};local __s_usec=\${__meterm_cmd_start#*.};`,
        `local __e_sec=\${EPOCHREALTIME%.*};local __e_usec=\${EPOCHREALTIME#*.};`,
        `dur=$(( (10#$__e_sec - 10#$__s_sec) * 1000 + (10#$__e_usec - 10#$__s_usec) / 1000 ));`,
        `else dur=$(( (\${EPOCHSECONDS:-$SECONDS} - \${__meterm_cmd_start%%.*}) * 1000 ));fi;`,
        `case "$dur" in ''|*[!0-9-]*) dur=0;; esac;`,
        `[ "$dur" -lt 0 ] 2>/dev/null&&dur=0;fi;fi;`,
        `__meterm_cmd_running=0;__meterm_in_prompt=0;`,
        `printf '\\033]7768;%d;%s;%s;%d\\007' "$e" "$PWD" "$c" "$dur"; };`,
        // One DEBUG trap per shell and no "append" form: installing ours would
        // *delete* whatever was there — `bash-preexec` and everything built on
        // it, audit/telemetry hooks — permanently, on a host this app does not
        // own. Without our trap `__meterm_cmd_running` stays 0, so the payload's
        // `duration_ms` is 0 and only the "long command finished" push is lost.
        `if [ -z "$(trap -p DEBUG)" ];then trap '__meterm_preexec' DEBUG;fi; `,
        // `PROMPT_COMMAND` can be extended safely, but only in the shape it
        // already has: bash 5.1+ allows an array, and a scalar assignment
        // replaces the whole array — silently dropping the user's 2nd..nth
        // entries. Both branches keep everything that was already there.
        `case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in 'declare -a'*) `,
        `PROMPT_COMMAND=(__meterm_precmd "\${PROMPT_COMMAND[@]}");; `,
        `*) PROMPT_COMMAND="__meterm_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac`,
      ].join('');
  }
}

// ─── Shell Hook Injection ───────────────────────────────────────

/**
 * Per-session injection bookkeeping.
 *
 * Injection used to be strictly one-shot: a single `_injectionAttempted` flag
 * meant that a failed attempt — shell still busy, slow `.zshrc`, or the
 * injection landing while a TUI owned the screen — left that session hookless
 * for the rest of its life, with nothing but a `!` badge to show for it. Retry
 * with backoff instead, bounded so a genuinely hookless host is not hammered.
 */
interface HookInjectionState {
  /**
   * Handshakes that were *sent* and never answered before the 3s timeout. This is
   * the bounded case: a shell that never runs our command should stop being asked
   * (see HOOK_RETRY_BACKOFF_MS).
   */
  failures: number;
  /**
   * Consecutive attempts skipped because a program (vim/less/top) or a password
   * prompt owned the screen. Nothing was sent, so it never spends the handshake
   * budget — see `scheduleHookRetry`.
   */
  blocked: number;
  /**
   * When this chain started trying (ms). The chain stops once the user has driven
   * the shell after that point — see the nested-ssh note on `injectionBlocked`.
   */
  startedAt: number;
  /** Pending retry timer, if one is queued. */
  retryTimer: ReturnType<typeof setTimeout> | null;
}

/** Delays between attempts. Length + 1 = total attempts (1 initial + 3 retries). */
const HOOK_RETRY_BACKOFF_MS = [5_000, 15_000, 60_000];

/** How long the handshake waits for the 7766 detect marker. */
const HOOK_INJECTION_TIMEOUT_MS = 3000;

const _injectionState = new Map<string, HookInjectionState>();

/**
 * The 7766 code that means "the shell which ran this line is not our host".
 * Deliberately outside 0..3, the shell-type indices `terminal-osc.ts` maps, so
 * it can never be read as a successful handshake.
 */
const HOOK_FOREIGN_HOST_CODE = 9;

/**
 * The one shell expression that identifies the host on the other end: the
 * machine id (systemd / dbus), the hostname, and the kernel boot id — stable
 * within a boot, different between machines, compared as a single string so
 * that any one differing field is enough to refuse. The SSH exec channel runs
 * exactly this (`server_info::HOST_IDENTITY_CMD`);
 * `tests/shell-hook-identity.test.mts` pins the two copies together, because a
 * drift here would refuse every injection.
 */
const HOST_IDENTITY_EXPR =
  '__meterm_id="$(cat /etc/machine-id 2>/dev/null||cat /var/lib/dbus/machine-id 2>/dev/null)'
  + '|$(hostname 2>/dev/null)'
  + '|$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"';

/**
 * Per-session answer to "which host is on the other end?".
 *
 * The screen cannot answer it: a nested `ssh` shows a bare shell prompt that the
 * detector reads as `active` (see `injectionBlocked`), so typing into it looks
 * exactly like typing into our own shell. The **exec channel** can: it is a
 * second channel on the connection we dialled, so what it runs, runs on the host
 * we dialled. Compare the two answers and the nested case identifies itself.
 *
 * Three states, and the third is what keeps this a guard rather than a feature:
 *   - `known`   → inject, guarded by the value.
 *   - `pending` → say nothing yet; the probe re-enters the injection itself.
 *   - `none`    → nothing to ask (local / JumpServer session) or the probe
 *                 failed: inject unguarded, exactly as before. An unavailable
 *                 guard may not turn into a missing feature.
 */
type HostIdentity =
  | { status: 'pending' }
  | { status: 'none' }
  | { status: 'known'; value: string };

const _hostIdentity = new Map<string, HostIdentity>();

/**
 * Ask the host we are connected to for its identity — never the shell, which may
 * be somewhere else by now. A `null` answer means "this session has no remote
 * exec channel" (local / JumpServer), which is not a failure and is remembered
 * as such; a rejected call is treated the same way, so a broken probe degrades
 * to the previous unguarded behaviour instead of blocking injection entirely.
 *
 * Every outcome is remembered, failure included, and that is deliberate: a
 * session with genuinely nothing to ask would otherwise be re-probed on every
 * single attempt, and since each probe re-enters the injection, that is an
 * endless probe loop rather than a degraded guard. The residual risk is the
 * mirror image — if the very first probe beats the SSH exec channel's
 * registration, the session keeps the unguarded behaviour for its lifetime,
 * which is exactly what shipped before this guard existed.
 */
async function probeHostIdentity(sessionId: string): Promise<void> {
  _hostIdentity.set(sessionId, { status: 'pending' });
  let next: HostIdentity;
  try {
    const value = await invoke<string | null>('ssh_host_identity', { sessionId });
    next = value ? { status: 'known', value } : { status: 'none' };
  } catch {
    next = { status: 'none' };
  }
  // A session that went away while we were asking must not be re-created here.
  if (!TerminalRegistry.get(sessionId)) {
    _hostIdentity.delete(sessionId);
    return;
  }
  _hostIdentity.set(sessionId, next);
}

/**
 * Ask, and hand control back to the injection once the answer is in.
 *
 * Deliberately **not** `scheduleHookRetry`, even though both are "come back
 * later". The chain is for attempts that did not land: it books a failure,
 * starts the clock the nested-ssh restraint measures the user's typing against,
 * and backs off. A probe wait is none of those — nothing was sent, so there is
 * nothing to retry and nothing to be restrained from. Routing it through the
 * chain let a user who started typing during the (millisecond) probe window trip
 * the restraint, which drops the entire chain and leaves the session hookless.
 */
function probeHostIdentityThenInject(sessionId: string): void {
  void probeHostIdentity(sessionId).then(() => {
    const mt = TerminalRegistry.get(sessionId);
    if (!mt || mt.shellState.hookInjected) return;
    injectShellHook(sessionId);
  });
}

/**
 * Is something other than the shell currently owning the terminal?
 *
 * The injection writes `Ctrl-U` + a command line + `\n`. Typed into a program
 * that has taken over the screen, none of that injects anything — it feeds the
 * text straight to that program: vim/less get a stray edit, `top` gets a bogus
 * keystroke. Silent-2s (the trigger in `ai-capsule-terminal-capture.ts`) is
 * equally true of `vim`, so this guard is what keeps the injection from typing
 * into them.
 *
 * Known gap: a *nested* `ssh` shows the remote's prompt, which the detector reads
 * as a bare shell prompt (`active`) — so this cannot catch that case, and typing
 * into it with the injection would land on the wrong host. The note that used to
 * stand here claimed "the attempt still fails the handshake, so the cost is a lost
 * attempt"; that is wrong. The remote shell has no `__meterm_hook_ready`, so it
 * runs the command happily and its 7766 marker comes straight back through the
 * PTY: the handshake *succeeds*. This session would be marked hooked while the
 * hook lives on the other host, its cwd / exit codes / durations would describe
 * that host, and `hookInjected` is precisely what switches the screen-tail
 * fallbacks off — so leaving the nested shell would put the agent back into the
 * state §1/§2.3 removed.
 *
 * This function is therefore not the defence against nesting — the host-identity
 * comparison is (`HostIdentity`, and `HOST_IDENTITY_EXPR` inside the injected
 * command). It runs on every 7766 answer, so a nested shell reports itself as
 * `HOOK_FOREIGN_HOST_CODE` instead of a success. The retry chain's typing
 * restraint (see `scheduleHookRetry`) stays as the cheap backstop for the paths
 * that never get a marker back at all.
 */
function injectionBlocked(sessionId: string): boolean {
  try {
    // Checked explicitly rather than delegated: this is a safety guard, and it
    // should not hinge on the detector's internal short-circuit order (it does
    // return 'tui' for alt-screen today, but that is its business, not ours).
    const altScreen = isAlternateScreen(sessionId);
    if (altScreen) return true;

    const tail = (TerminalRegistry.serializeBuffer(sessionId) ?? '')
      .slice(-WATCH_DETECT_TAIL_CHARS);
    return detectInteractiveState(tail, altScreen).state !== 'active';
  } catch {
    return false; // unreadable screen must not block injection
  }
}

/**
 * Start the retry-chain clock, leaving a running chain's clock alone.
 *
 * The baseline has to be "when we first tried", not "when the last attempt
 * failed": the nested-ssh restraint in `scheduleHookRetry` asks whether the user
 * has typed *since we started*, and typing that happened during the first
 * handshake window — or between two retries — still means the prompt on screen
 * may no longer be ours.
 */
function beginInjectionChain(sessionId: string): void {
  if (_injectionState.has(sessionId)) return;
  _injectionState.set(sessionId, {
    failures: 0,
    blocked: 0,
    startedAt: Date.now(),
    retryTimer: null,
  });
}

/**
 * Book one attempt and queue the next.
 *
 * The two reasons an attempt did not land are not equivalent, and only one of
 * them is worth bounding:
 *
 * - `blocked` sent *nothing*. Booking it as a failure meant four attempts spent
 *   inside vim/less/top burned the whole budget, and `injectShellHook` then
 *   refused for good — the session stayed hookless even after the user was back
 *   at a normal shell prompt. Blocked waits therefore saturate at the longest
 *   tier and keep trying (one screen read each, no I/O) until the screen frees up
 *   or the session is gone.
 * - A sent-but-unanswered attempt is the bounded case: it spends `failures`, and
 *   once the tiers run out, a shell that never answers stops being asked.
 *
 * A third way out exists while the retry is in flight, and it is not a *reason an
 * attempt failed* at all: the session may stop being ours to drive. See the
 * restraint in the timer below — it is consulted only when the host-identity gate
 * has nothing to say.
 */
function scheduleHookRetry(sessionId: string, blocked: boolean): void {
  const state = _injectionState.get(sessionId) ?? {
    failures: 0,
    blocked: 0,
    startedAt: Date.now(),
    retryTimer: null,
  };
  if (blocked) state.blocked += 1;
  else state.failures += 1;
  _injectionState.set(sessionId, state);

  // Only the sent-and-unanswered kind can be exhausted; a blocked chain has
  // nothing to give up on, it is waiting for the screen.
  if (!blocked && state.failures > HOOK_RETRY_BACKOFF_MS.length) return;

  const spent = blocked ? state.blocked : state.failures;
  // `Math.min` saturates: a blocked chain keeps coming back at the last tier.
  const delay = HOOK_RETRY_BACKOFF_MS[Math.min(spent, HOOK_RETRY_BACKOFF_MS.length) - 1];

  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    const mt = TerminalRegistry.get(sessionId);
    // Session went away while we waited — drop the bookkeeping rather than
    // retry into a dead terminal (this is the only cleanup path we get, since
    // importing this module from terminal.ts would be a cycle).
    if (!mt) {
      _injectionState.delete(sessionId);
      return;
    }
    // The restraint only runs where nothing better is available.
    //
    // It is a guess — "the user typed, so the prompt on screen may belong to a
    // shell `ssh`-nested inside it" — and two things make it a bad guess to act
    // on when we have the real answer:
    //
    // - A session whose connected host we identified carries a positive check in
    //   the command itself (`HostIdentity`): it is sent only if the host it runs
    //   on is the host we dialled, and reports `HOOK_FOREIGN_HOST_CODE` otherwise.
    //   That answer is about the host, not about keystrokes, so it does not care
    //   what the user typed or when.
    // - Acting on the guess costs real installs. Leaving `vim`/`less`/`top` with
    //   `q` is typing, and it used to drop the whole chain here — after which
    //   nothing retried, because the capture path unsubscribes from the output
    //   stream on its first attempt. The session stayed hookless for the rest of
    //   its life, and the blocked-not-failed fix above (which exists precisely so
    //   that time spent in a TUI is not punishable) was undone by a single key.
    //
    // The cost of dropping the guess on a guarded session: a retry that fires
    // after the user re-nested still types the command into that prompt, and only
    // learns from the answer that it was the wrong host. Nothing is installed, so
    // the failure mode stays "hookless", not "hooked to the wrong machine". Note
    // that the *first* attempt has never had this protection at all, and a
    // password prompt is what `injectionBlocked` is for.
    const guarded = _hostIdentity.get(sessionId)?.status === 'known';
    if (!guarded && mt.shellState.lastUserInputAt >= state.startedAt) {
      _injectionState.delete(sessionId);
      return;
    }
    injectShellHook(sessionId);
  }, delay);
}

/** Forget a session's retry bookkeeping once the hook is in place. */
function clearHookRetry(sessionId: string): void {
  const state = _injectionState.get(sessionId);
  if (state?.retryTimer) clearTimeout(state.retryTimer);
  _injectionState.delete(sessionId);
}

/**
 * Inject the shell prompt hook into the terminal session (SSH/remote fallback).
 *
 * For local shells, the Go sidecar pre-installs the hook via ZDOTDIR (zsh) or
 * --rcfile (bash), making this function a no-op (hookInjected is already true
 * from the first OSC 7768 received).
 *
 * For SSH/remote shells, uses the xterm.js **alternate screen buffer**:
 *   1. Switch to alt screen (main screen with MOTD/prompt is preserved)
 *   2. Send injection command (all echo goes to alt screen)
 *   3. Wait for completion
 *   4. Switch back to main screen (alt screen discarded)
 */
export function injectShellHook(sessionId: string): boolean {
  const mt = TerminalRegistry.get(sessionId);
  if (!mt) {
    _injectionState.delete(sessionId);
    return false;
  }
  if (mt.shellState.hookInjected) {
    clearHookRetry(sessionId);
    return true;
  }
  // Check settings — user can disable SSH hook injection
  if (!loadSettings().shellHookInjection) return false;

  const state = _injectionState.get(sessionId);
  // A retry is already queued; do not stack another handshake on top of it.
  if (state?.retryTimer) return false;
  // Every attempt spent — stop for good (matches the old one-shot behaviour,
  // minus the part where "one shot" meant "one attempt").
  if (state && state.failures > HOOK_RETRY_BACKOFF_MS.length) return false;

  if (injectionBlocked(sessionId)) {
    scheduleHookRetry(sessionId, true);
    return false;
  }
  // Nothing may be typed before we know which host answers on the other end —
  // see `HostIdentity`. This is *not* a blocked attempt: nothing was sent, so it
  // books nothing against the chain and does not start the restraint clock. The
  // probe re-enters this function itself once it has an answer.
  const host = _hostIdentity.get(sessionId);
  if (!host) {
    probeHostIdentityThenInject(sessionId);
    return false;
  }
  // A probe is already in flight; its own continuation comes back here.
  if (host.status === 'pending') return false;
  // Committed to a real attempt: this is where the clock that the nested-ssh
  // restraint measures the user's typing against starts.
  beginInjectionChain(sessionId);
  return _injectShellHookImpl(sessionId, mt, host.status === 'known' ? host.value : undefined);
}

/**
 * "Is the shell that is about to run this really our host?", as one command that
 * every shell MeTerm supports can run.
 *
 * The comparison has to happen where the command *lands* — that is the whole
 * point — but the shape it used to be written in (`__meterm_id=…; if [ … ];
 * then …; fi`) is not something the three dialects agree on, and fish is the
 * loud one: it parses the entire line before running any of it, so a single
 * construct it does not know costs the session the hook outright
 * (`__meterm_id=…` → *Unsupported use of '='*). A guard that only works in the
 * shells that do not need it is not a guard.
 *
 * So the comparison is delegated to a POSIX `sh` we start ourselves, and the
 * foreground shell is left with `sh -c '<script>' meterm '<expected>'` — a
 * command, one argument, and the `&&` the caller already needs. The expected
 * value travels as `$1` rather than as interpolated text, so a hostname holding
 * quotes or `$` is inert.
 *
 * The exit status is the whole protocol: 0 means "ours, go ahead", and anything
 * else means the 7766 refusal has already been printed and the caller's `&&`
 * skips the install. Keeping the refusal inside the guard — rather than in an
 * `else` branch after the body — is deliberate: it then cannot be triggered by
 * an unrelated non-zero status from inside the install.
 *
 * `HOST_IDENTITY_EXPR` is interpolated unchanged, so the drift guard that pins
 * it against `server_info::HOST_IDENTITY_CMD` keeps working.
 */
function hostGuardCommand(expectedHost: string, detectId: string): string {
  const script =
    `${HOST_IDENTITY_EXPR}; `
    + `if [ "$__meterm_id" = "$1" ]; then exit 0; fi; `
    + `printf '\\033]7766;${detectId};${HOOK_FOREIGN_HOST_CODE}\\007'; exit 1`;
  return `sh -c '${escapeShellSingle(script)}' meterm '${escapeShellSingle(expectedHost)}'`;
}

function _injectShellHookImpl(
  sessionId: string,
  mt: ReturnType<typeof TerminalRegistry.get> & {},
  /** The connected host's identity, when we were able to ask for one. */
  expectedHost?: string,
): boolean {
  const zshHook = buildShellHook('zsh');
  const bashHook = buildShellHook('bash');
  const fishHook = buildShellHook('fish');
  const detectId = `det_${Date.now().toString(36)}`;

  // Whose shell is this, really? `expectedHost` is the answer from the exec
  // channel — the host we dialled; the shell that runs this line answers for
  // wherever the user's foreground prompt actually is. When the two disagree the
  // command has landed somewhere else entirely (a nested `ssh`'s remote shell),
  // so it reports that and installs nothing: the session stays hookless instead
  // of being marked hooked with another machine's cwd, exit codes and durations —
  // and `hookInjected` is exactly what switches the screen-tail fallbacks off.
  // Unguarded when there is nothing to compare against — see `HostIdentity`.
  //
  // The check is spliced into each branch as its first `&&` operand, which keeps
  // every dialect happy without any grouping or re-quoting: `sh -c '<script>'
  // meterm '<expected>'` is one command whose *status* is the answer, and a
  // refusal prints the 7766 marker and exits non-zero, so the branch stops
  // before it can install anything. The alternatives do not survive fish —
  // `guard && eval '<body>'` re-escapes the body's own quotes into `'''`, which
  // fish reads as an unbalanced string, and `( guard && body )` / `{ …; }` have
  // no fish equivalent at all.
  //
  // Exactly one branch can be taken in any real shell — `$ZSH_VERSION`,
  // `$BASH_VERSION` and `$FISH_VERSION` are mutually exclusive — so the check
  // costs one `sh` per injection rather than three, and a refusal produces one
  // marker, not three. Empty when there is nothing to compare against, which
  // reproduces the unguarded command byte for byte.
  const guard = expectedHost === undefined
    ? ''
    : `${hostGuardCommand(expectedHost, detectId)} && `;

  // Single-line polyglot: `test -n` guards ensure only the matching branch runs.
  // __meterm_hook_ready guard: skip if Go sidecar already installed the hook.
  const body = [
    ` test -n "$ZSH_VERSION" && ${guard}test -z "$__meterm_hook_ready" &&`,
    `printf '\\033]7766;${detectId};1\\007' &&`,
    `eval '${escapeShellSingle(zshHook)}' &&`,
    `setopt HIST_IGNORE_SPACE 2>/dev/null;`,
    `test -n "$BASH_VERSION" && ${guard}test -z "$__meterm_hook_ready" &&`,
    `printf '\\033]7766;${detectId};0\\007' &&`,
    `eval '${escapeShellSingle(bashHook)}' &&`,
    `history -d $HISTCMD 2>/dev/null;`,
    // Two things about this line, both consequences of fish parsing the *whole*
    // injected line before running any of it:
    //
    //   - `${HISTCONTROL:+…}` is a bash/zsh idiom fish cannot parse at all
    //     (`${` is "not a valid variable in fish"), and a construct in a branch
    //     fish never takes still costs every fish session the hook. `"$HISTCONTROL:
    //     ignorespace"` is the same list either way — an unset variable
    //     contributes an empty entry, which every reader of `HISTCONTROL` skips.
    //   - Fixing that also *runs* the line in fish for the first time ever, so it
    //     is gated on the shells that have a `HISTCONTROL`: exporting a
    //     bash-only variable into a fish session is a change to a remote host's
    //     environment, and the point of this pass is to make fish work, not to
    //     make it different. (`$BASH_VERSION$ZSH_VERSION` is empty in fish, so
    //     the `test` fails there — the concatenation is the portable way to ask
    //     "either of these?".)
    `test -n "$BASH_VERSION$ZSH_VERSION" && export HISTCONTROL="$HISTCONTROL:ignorespace";`,
    `test -n "$FISH_VERSION" && ${guard}test -z "$__meterm_hook_ready" &&`,
    `printf '\\033]7766;${detectId};2\\007' &&`,
    `eval '${escapeShellSingle(fishHook)}';`,
    `printf '\\0338\\033[0J\\033[0m\\r\\033[2K'`,
  ].join(' ');

  // Switch to alternate screen buffer BEFORE sending.
  mt.terminal.write('\x1b[?1049h');

  TerminalRegistry.sendInput(sessionId, '\x15' + body + '\n');

  const restoreScreen = () => {
    mt.terminal.write('\x1b[?1049l');
    mt.terminal.scrollToBottom();
  };

  const timeout = setTimeout(() => {
    unsub();
    restoreScreen();
    // No detect marker: the shell never ran (still busy, slow rc, echoed into
    // a program that swallowed it). Queue another attempt — this one *was* sent,
    // so it spends the bounded handshake budget.
    scheduleHookRetry(sessionId, false);
  }, HOOK_INJECTION_TIMEOUT_MS);
  const unsub = TerminalRegistry.onOscMarker(sessionId, detectId, (code) => {
    clearTimeout(timeout);
    restoreScreen();
    if (code === HOOK_FOREIGN_HOST_CODE) {
      // The other host answered: the command was typed into a shell that is not
      // the connection we dialled, so nothing was installed. Stop rather than
      // retry — this is *evidence* that the foreground shell is nested, which is
      // stronger than the typing heuristic `scheduleHookRetry` has to fall back
      // on, and retrying while the user is still in that shell can only report
      // the same thing. The next agent turn asks again from a clean state (the
      // trade-off the restraint above already makes). The cached identity goes
      // with it, so that re-ask probes afresh and a spurious mismatch costs one
      // probe instead of the guard.
      clearHookRetry(sessionId);
      _hostIdentity.delete(sessionId);
      return;
    }
    // The marker is emitted inside the `test -z "$__meterm_hook_ready"` guard,
    // so receiving one means a shell branch really ran. (The old `code !== -1`
    // test was dead: resolver() coerces NaN to 0, so code ∈ {0,1,2,9} — 9 is
    // handled above and never reaches this line.)
    setShellType(sessionId, code === 1 ? 'zsh' : code === 2 ? 'fish' : 'bash');
    mt.shellState.hookInjected = true;
    clearHookRetry(sessionId);
  });

  return false; // hookInjected will be set asynchronously via callback
}

// ─── Command Execution Waiters ──────────────────────────────────
//
// These two waiters now share a single detection strategy:
//
//   1. Shell-hook idle (OSC 7768) — the BEST signal. Means the shell
//      is back at its prompt and the command truly finished. Resolves
//      as status='completed' with the real exit code + cwd.
//
//   2. Interactive-state detector — after ~1.5 seconds of silence
//      following actual output, we inspect the tail of the buffer
//      for password/confirm/TUI patterns (ai-tools-prompt-detect.ts).
//      If we find one, we RESOLVE EARLY with a specific status so the
//      LLM knows to use type_text / press_keys / watch_terminal. We do NOT fake
//      an exit code.
//
//   3. xterm.js alternate-screen buffer — checked alongside (2).
//      If the terminal switched to alt-screen, the foreground process
//      has taken over the display (vim/top/htop/less/etc). We resolve
//      as 'tui'.
//
//   4. Hard deadline — if none of the above fire within timeoutSec,
//      we resolve as 'timeout' (command may still be running).
//
// Critically, we NEVER fake an OSC 7766 marker via `inject_osc_marker`
// anymore. That hack caused run_command to lie about completion
// whenever a process blocked the PTY waiting for input.

/** Status of a terminal wait, reflecting WHY we stopped waiting. */
export type WaitStatus =
  | 'completed'          // shell hook fired — command truly finished
  | 'waiting_password'   // detector saw a password prompt
  | 'waiting_confirm'    // detector saw a Y/n prompt
  | 'waiting_input'      // detector saw a generic "xxx:" prompt tail
  | 'tui'                // xterm alt-screen flipped on
  | 'idle_no_signal'     // silent for a long time, no shell hook
  | 'timeout'            // hit the hard deadline
  | 'aborted';           // external abort signal

export interface WaitResult {
  output: string;
  exitCode: number;
  cwd: string;
  status: WaitStatus;
  /** Optional prompt line that triggered the detector (for LLM hints). */
  detectorLine?: string;
  /** Structured prompt info when a library-specific parser matched. */
  promptInfo?: PromptInfo;
}

/** Configuration for the hybrid wait loop. */
interface WaitOptions {
  /** Hard deadline in seconds. */
  timeoutSec: number;
  /** Silence threshold before the detector fires (ms). */
  detectAfterSilenceMs: number;
  /** Silence threshold before we give up with idle_no_signal (ms). */
  giveUpAfterSilenceMs: number;
}

/**
 * Read the current xterm buffer type. Returns true iff the terminal is
 * in alternate-screen mode (TUI program has taken over).
 */
function isAlternateScreen(sessionId: string): boolean {
  const mt = TerminalRegistry.get(sessionId);
  try {
    return mt?.terminal.buffer.active.type === 'alternate';
  } catch {
    return false;
  }
}

/**
 * Map a detector state → wait status (1:1 except 'active').
 */
function detectorToStatus(state: InteractiveState): WaitStatus | null {
  switch (state) {
    case 'waiting_password': return 'waiting_password';
    case 'waiting_confirm':  return 'waiting_confirm';
    case 'waiting_input':    return 'waiting_input';
    case 'tui':              return 'tui';
    case 'active':           return null;
  }
}

/**
 * Core wait loop — listens for output, shell-idle, and periodically
 * runs the interactive-state detector.  Used by BOTH the hook-enabled
 * path and the hookless fallback; the only difference is whether
 * onShellIdle will ever fire.
 */
function runWaitLoop(
  sessionId: string,
  options: WaitOptions,
  signal?: { aborted: boolean },
): Promise<WaitResult> {
  const { timeoutSec, detectAfterSilenceMs, giveUpAfterSilenceMs } = options;
  // Baseline alt-screen state captured BEFORE the command is sent.
  // This lets us distinguish "the command just entered a TUI" from
  // "we were already inside tmux/screen/vim from a previous command".
  // We only report status='tui' when the flag flips false → true.
  const baselineAltScreen = isAlternateScreen(sessionId);

  return new Promise((resolve) => {
    let outputBuffer = '';
    let resolved = false;
    let lastOutputTime = Date.now();
    let hadAnyOutput = false;

    // Read fresh on every check: the hook can finish being injected, and
    // the user can type, while this command is still in flight.
    const hookAlive = () => !!TerminalRegistry.get(sessionId)?.shellState.hookInjected;
    const userTypedJustNow = () => userTypedRecently(
      TerminalRegistry.get(sessionId)?.shellState.lastUserInputAt ?? 0,
      Date.now(),
    );

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      unsubOutput();
      unsubIdle();
      clearTimeout(deadline);
      clearInterval(checkTimer);
    };

    const finish = (result: WaitResult) => {
      if (resolved) return;
      cleanup();
      resolve(result);
    };

    // ── Hard deadline ──
    const deadline = setTimeout(() => {
      const mt = TerminalRegistry.get(sessionId);
      finish({
        output: stripAnsi(outputBuffer)
          + `\n[Command timed out after ${timeoutSec}s — may still be running]`,
        exitCode: -1,
        cwd: mt?.shellState.cwd ?? '',
        status: 'timeout',
      });
    }, timeoutSec * 1000);

    // ── Periodic detector check ──
    // Runs every 300ms and checks, in order:
    //   (a) External abort signal was set — stop immediately even
    //       if no output has arrived (silent process case).
    //   (b) Did alt-screen flip on? → status='tui' (baseline-aware).
    //   (c) Been silent for detectAfterSilenceMs? → run the
    //       interactive-state detector on the buffer tail.
    //   (d) Been silent for giveUpAfterSilenceMs? → 'idle_no_signal'.
    const checkTimer = setInterval(() => {
      if (resolved) return;

      // (a) Abort check runs every tick so Ctrl+C works even when
      // the child process is dead silent (no output events arrive).
      if (signal?.aborted) {
        finish({
          output: stripAnsi(outputBuffer) + '\n[执行被用户中止]',
          exitCode: -1,
          cwd: '',
          status: 'aborted',
        });
        return;
      }

      const silentMs = Date.now() - lastOutputTime;

      // (a) alt-screen transition (only if we didn't already start
      // inside an alt-screen session like tmux — otherwise we'd
      // always trigger 'tui' and never listen to the real signals).
      if (!baselineAltScreen && isAlternateScreen(sessionId)) {
        const mt = TerminalRegistry.get(sessionId);
        finish({
          output: stripAnsi(outputBuffer),
          exitCode: 0,
          cwd: mt?.shellState.cwd ?? '',
          status: 'tui',
        });
        return;
      }

      // (b) Prompt detector only makes sense once we've actually seen
      // some output AND the stream has been silent for a beat — a
      // command that's still streaming output is clearly not waiting.
      if (hadAnyOutput && silentMs >= detectAfterSilenceMs) {
        const detect = detectInteractiveState(outputBuffer, false);
        // When we're already inside a tmux alt-screen we must NOT
        // report 'tui' from the detector (detectInteractiveState
        // also honors the altScreen flag, so pass false here to
        // skip that shortcut — we handled alt-screen above).
        const status = detectorToStatus(detect.state);
        if (status && status !== 'tui') {
          const mt = TerminalRegistry.get(sessionId);
          finish({
            output: stripAnsi(outputBuffer),
            exitCode: 0,
            cwd: mt?.shellState.cwd ?? '',
            status,
            detectorLine: detect.matchedLine,
            promptInfo: detect.promptInfo,
          });
          return;
        }

        // (b') Hookless shell prompt completion fallback:
        // When OSC 7768 isn't available, the buffer tail being a
        // shell prompt ("$ "/"# "/"% "/"> ") after silence is the
        // best "command finished" signal we have — but it is only
        // evidence when the hook cannot speak for this session AND the
        // prompt is not one the user just produced. With a hook present
        // the onShellIdle listener below is authoritative, and a
        // prompt-shaped tail would hand us the PREVIOUS command's exit
        // code instead of this one's.
        const tailIsPrompt = endsWithShellPrompt(outputBuffer);
        if (shouldCompleteFromPromptTail({
          hookInjected: hookAlive(),
          recentUserInput: userTypedJustNow(),
          tailIsPrompt,
        })) {
          finish({
            output: stripAnsi(outputBuffer)
              + '\n[exit code unavailable: this session has no shell hook]',
            // Visual detection can never know the real exit status, so
            // say so instead of reporting lastExitCode — without a hook
            // that field keeps its initial 0, which would report every
            // failed command as a success.
            exitCode: EXIT_CODE_UNKNOWN,
            cwd: TerminalRegistry.get(sessionId)?.shellState.cwd ?? '',
            status: 'completed',
          });
          return;
        }
      }

      // (c) Give-up path: silent for a long time AND still no shell
      // hook AND no detector match AND no prompt tail. Return what
      // we have so the caller can decide.
      if (hadAnyOutput && silentMs >= giveUpAfterSilenceMs) {
        finish({
          output: stripAnsi(outputBuffer)
            + `\n[No shell-idle signal for ${Math.round(silentMs/1000)}s; the process may still be running or waiting]`,
          exitCode: exitCodeFromHook(sessionId),
          cwd: TerminalRegistry.get(sessionId)?.shellState.cwd ?? '',
          status: 'idle_no_signal',
        });
      }
    }, 300);

    // ── Output listener ──
    const unsubOutput = TerminalRegistry.onOutput(sessionId, (data) => {
      if (resolved) return;
      if (signal?.aborted) {
        finish({
          output: stripAnsi(outputBuffer) + '\n[执行被用户中止]',
          exitCode: -1,
          cwd: '',
          status: 'aborted',
        });
        return;
      }
      outputBuffer += data;
      hadAnyOutput = true;
      lastOutputTime = Date.now();
    });

    // ── Shell hook idle (OSC 7768) — authoritative "command done". ──
    const unsubIdle = TerminalRegistry.onShellIdle(sessionId, () => {
      finish({
        output: stripAnsi(outputBuffer),
        // The 7768 handler writes lastExitCode immediately before
        // firing this event, so this is the real exit status of the
        // command we are waiting on.
        exitCode: exitCodeFromHook(sessionId),
        cwd: TerminalRegistry.get(sessionId)?.shellState.cwd ?? '',
        status: 'completed',
      });
    });
  });
}

// ─── Execute Agent Command ──────────────────────────────────────

/**
 * Execute a command in the terminal and wait for it to complete, block,
 * or enter an interactive state.  Returns a structured result the
 * caller can surface to the LLM.
 *
 * Strategy differences vs. the old implementation:
 *
 *   • No more synthetic OSC 7766 marker injection. That caused
 *     run_command to return success while the process was still
 *     blocking on a password prompt.
 *
 *   • No more `; printf '...7766...'` suffix on the command. That
 *     never fires for interactive/TUI programs anyway and caused
 *     confusing echoes in the terminal.
 *
 *   • A single `runWaitLoop` handles both hook-enabled and hookless
 *     paths. The only difference is that without the shell hook,
 *     'completed' status will never fire — the loop resolves via
 *     detector / alt-screen / idle_no_signal / timeout instead.
 */
export async function executeAgentCommand(
  sessionId: string,
  cmd: string,
  shellType: string,
  timeoutSec: number,
  signal?: { aborted: boolean },
): Promise<{
  output: string;
  exitCode: number;
  cwd: string;
  status: WaitStatus;
  detectorLine?: string;
  promptInfo?: PromptInfo;
}> {
  // Acquire the per-session PTY lock so that any other tool currently
  // touching this session's PTY (run_command, type_text, press_keys,
  // watch_terminal, or any SSH-routed read_file / write_file /
  // list_directory / glob_search / grep_search) finishes before we
  // send our command. Without this, the orchestrator would happily
  // fan out 5 read_files / list_directories / grep_searches in
  // parallel on the same SSH session and the captured outputs would
  // interleave on the wire, corrupting all of them.
  return withSessionPtyLock(sessionId, async () => {
    const mt = TerminalRegistry.get(sessionId);
    const hookReady = !!mt?.shellState.hookInjected && shellType !== 'powershell';

    const waitOpts = hookReady
      ? { timeoutSec, detectAfterSilenceMs: 1_500, giveUpAfterSilenceMs: 30_000 }
      : { timeoutSec, detectAfterSilenceMs: 1_500, giveUpAfterSilenceMs: 5_000 };

    const resultPromise = runWaitLoop(sessionId, waitOpts, signal);
    TerminalRegistry.sendAgentCommand(sessionId, ` ${cmd}`, shellType);
    const result = await resultPromise;

    return {
      output: cleanOutput(result.output, cmd),
      exitCode: result.exitCode,
      cwd: result.cwd,
      status: result.status,
      detectorLine: result.detectorLine,
      promptInfo: result.promptInfo,
    };
  });
}

/**
 * Execute a command via terminal and capture output (used by read_file/write_file on SSH).
 * Returns only the text portion — interactive status is discarded,
 * which is fine because these helpers wrap simple, non-interactive
 * commands (head, cat > heredoc, etc.).
 */
export async function executeViaTerminal(
  sessionId: string,
  cmd: string,
  timeoutSec = 15,
  shellType = 'bash',
): Promise<string> {
  const { output } = await executeAgentCommand(sessionId, cmd, shellType, timeoutSec);
  return truncateOutput(output, TOKEN_BUDGET.perToolOutputChars);
}

/** Re-export for external consumers (run_command) that need the state label. */
export { describeState };

/**
 * Clean captured output: strip command echo line and trailing prompt lines.
 */
export function cleanOutput(raw: string, sentCommand?: string): string {
  const lines = stripAnsi(raw).split('\n');

  // Strip command echo (first occurrence within first 3 lines)
  let start = 0;
  if (sentCommand) {
    const cmdText = sentCommand.trim();
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      if (lines[i].includes(cmdText)) { start = i + 1; break; }
    }
  }

  // Strip trailing blank/prompt lines
  let end = lines.length;
  for (let i = lines.length - 1; i >= start; i--) {
    const t = lines[i].trim();
    if (t === '' || /^.*[\$#%>]\s*$/.test(t)) end = i;
    else break;
  }

  return lines.slice(start, end).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Session teardown ────────────────────────────────────────────
// Both maps in this module are keyed by session id and were only ever written
// to, so a long-running window accumulated one entry per session it had ever
// opened. Retry bookkeeping had a self-clean path (the retry timer notices a
// dead session) but a cancelled timer never fires, and the PTY tail map had
// none at all. Register through the cycle-free lifecycle module so cleanup can
// be installed without reading TerminalRegistry before it initializes.
onTerminalSessionDisposed((sessionId) => {
  // Drop the serialization tail: nothing can be in flight for a session whose
  // terminal is gone, and keeping a resolved promise alive would pin the
  // closure chain it chained onto.
  sessionPtyTails.delete(sessionId);
  // Cancels a pending retry timer as well as the record.
  clearHookRetry(sessionId);
  // The host identity belongs to the connection, not to the session id.
  _hostIdentity.delete(sessionId);
});
