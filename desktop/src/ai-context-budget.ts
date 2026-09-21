// ─── AI Agent: Terminal Context Budget ──────────────────────────
// Pure constants + helpers that decide how much terminal output gets
// injected into the agent's system prompt.
//
// This module deliberately has NO imports: the renderer-side context
// builder (ai-agent-context.ts) pulls in terminal/tabs/drawer, none of
// which load outside a browser, so keeping the budget maths here is the
// only way to unit-test it.
//
// Background: the pane excerpt used to be hardcoded to the last 3 lines
// / 250 chars, while the capture side was hardcoded to 80 lines, and the
// user-facing `aiContextLines` setting (slider 10–200) was read by
// nothing at all. These constants are the single source of truth for
// that budget now.

/**
 * Hard cap on ALL terminal context injected into the system prompt,
 * summed across every pane of the tab. Panes share this pool by
 * dividing what is left among them, so a 4-pane tab can never inflate
 * the prompt without bound.
 *
 * ≈4000 tokens, and the system prompt is resent on every agent
 * iteration, so this is a real recurring cost — not a one-off.
 */
export const SYSTEM_CONTEXT_CHARS = 12000;

/**
 * Characters kept per line of a pane excerpt. Headroom for wide
 * terminals and soft-wrapped output. The line budget is the primary
 * control; this only bites on unusually long lines (minified JS, a
 * `cat` of a build log) so one such line cannot eat the whole pool.
 */
export const CONTEXT_CHARS_PER_LINE = 200;

/**
 * Fallback pane-excerpt line count, used only when
 * `settings.aiContextLines` is missing. The live value is
 * user-controlled via the settings slider, so this is a safety net
 * rather than the real setting.
 */
export const DEFAULT_CONTEXT_LINES = 10;

/**
 * Take the last `maxLines` lines of a pane's captured output, then trim
 * the result to at most `maxChars` (and never more than
 * `maxLines * CONTEXT_CHARS_PER_LINE`).
 *
 * Lines are selected first and characters second, so the character cap
 * only ever bites on unusually long lines instead of silently shrinking
 * the window the caller asked for.
 *
 * Returns '' for any non-positive budget, so callers can pass a share
 * that has already been exhausted without a special case.
 */
export function excerptForPane(
  raw: string,
  maxLines: number,
  maxChars: number,
): string {
  if (!raw || maxLines <= 0 || maxChars <= 0) return '';
  const cap = Math.min(maxChars, maxLines * CONTEXT_CHARS_PER_LINE);
  return raw.split('\n').slice(-maxLines).join('\n').slice(0, cap);
}
