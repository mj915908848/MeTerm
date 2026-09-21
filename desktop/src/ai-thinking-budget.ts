// ─── AI: Reasoning-token Budget ─────────────────────────────────
// Thinking models spend part of max_tokens on a reasoning pass BEFORE
// they answer, and those tokens are billed as output. With no cap the
// model decides how long to think, so a hard problem can consume the
// whole budget and leave the reply truncated — the symptom looks like
// "it stopped halfway through", not like a token-limit error.
//
// This module owns both the tier list and the request-body fields, so
// the settings UI and the provider can never disagree about what a tier
// means.
//
// Zero imports on purpose: ai-provider.ts pulls in the transport stack,
// which does not load under `node --test`, and settings-ai.ts pulls in
// the whole DOM layer.

/** 0 means "send no cap; let the provider use its own default". */
export const DEFAULT_THINKING_BUDGET = 0;

/**
 * Tiers offered in settings. Order drives the dropdown, so keep it
 * ascending. Values are tokens reserved for the reasoning pass.
 */
export const THINKING_BUDGET_TIERS = [
  { value: 0, labelKey: 'aiThinkingBudgetDefault' },
  { value: 4096, labelKey: 'aiThinkingBudgetLow' },
  { value: 16384, labelKey: 'aiThinkingBudgetMedium' },
  { value: 32768, labelKey: 'aiThinkingBudgetHigh' },
] as const;

/** True when the value selects a real cap rather than "provider default". */
export function isThinkingBudgetTier(value: number): boolean {
  return THINKING_BUDGET_TIERS.some((tier) => tier.value === value);
}

/**
 * Top-level fields to merge into an OpenAI-compatible request body.
 *
 * The three thinking flags go out together on purpose: providers use
 * different names — `thinking` for DeepSeek/GLM, `enable_thinking` for
 * Qwen3/DashScope, `chat_template_kwargs` for vLLM-served Qwen3 — and
 * each reads the one it knows while ignoring the rest.
 *
 * `thinking_budget` is added ONLY when thinking is actually on. A cap for
 * a phase that will not run is at best noise to the gateway and at worst
 * a rejected request.
 */
export function thinkingFieldsFor(
  enableThinking: boolean | undefined,
  thinkingBudget: number | undefined,
): Record<string, unknown> {
  if (typeof enableThinking !== 'boolean') return {};

  const fields: Record<string, unknown> = {
    thinking: { type: enableThinking ? 'enabled' : 'disabled' },
    enable_thinking: enableThinking,
    chat_template_kwargs: { enable_thinking: enableThinking },
  };

  if (enableThinking && typeof thinkingBudget === 'number' && thinkingBudget > 0) {
    fields.thinking_budget = thinkingBudget;
  }

  return fields;
}
