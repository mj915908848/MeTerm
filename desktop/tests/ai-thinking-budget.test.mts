import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_THINKING_BUDGET,
  THINKING_BUDGET_TIERS,
  isThinkingBudgetTier,
  thinkingFieldsFor,
} from '../src/ai-thinking-budget.ts';

test('no thinking fields are sent when the toggle is unset', () => {
  assert.deepEqual(thinkingFieldsFor(undefined, 16384), {});
});

test('thinking off sends the disabled flags but never a budget', () => {
  const fields = thinkingFieldsFor(false, 16384);
  assert.deepEqual(fields.thinking, { type: 'disabled' });
  assert.equal(fields.enable_thinking, false);
  assert.deepEqual(fields.chat_template_kwargs, { enable_thinking: false });
  assert.ok(
    !('thinking_budget' in fields),
    'a budget was sent while thinking was off — a cap for a phase that never runs',
  );
});

test('thinking on without a budget still sends the enabled flags', () => {
  const fields = thinkingFieldsFor(true, undefined);
  assert.deepEqual(fields.thinking, { type: 'enabled' });
  assert.equal(fields.enable_thinking, true);
  assert.ok(!('thinking_budget' in fields));
});

test('the provider-default tier (0) sends no cap', () => {
  assert.ok(!('thinking_budget' in thinkingFieldsFor(true, DEFAULT_THINKING_BUDGET)));
});

test('a real tier rides along as a top-level thinking_budget', () => {
  const fields = thinkingFieldsFor(true, 16384);
  assert.equal(fields.thinking_budget, 16384);
  // Must be top-level, next to enable_thinking — nesting it under
  // `thinking` (the Anthropic shape) would not be read by the
  // OpenAI-compatible gateway.
  const nested = fields.thinking as Record<string, unknown>;
  assert.ok(!('thinking_budget' in nested), 'thinking_budget must not be nested');
});

test('negative budgets are treated as no cap', () => {
  assert.ok(!('thinking_budget' in thinkingFieldsFor(true, -1)));
});

test('tiers ascend and the first one is the provider default', () => {
  assert.equal(
    DEFAULT_THINKING_BUDGET,
    0,
    '0 is the sentinel for send-no-cap; changing it re-enables capping by default',
  );
  assert.equal(THINKING_BUDGET_TIERS[0].value, DEFAULT_THINKING_BUDGET);
  const values = THINKING_BUDGET_TIERS.map((t) => t.value);
  assert.deepEqual(values, [...values].sort((a, b) => a - b), 'tiers must ascend');
  assert.equal(new Set(values).size, values.length, 'tiers must be unique');
});

test('isThinkingBudgetTier accepts exactly the offered tiers', () => {
  for (const tier of THINKING_BUDGET_TIERS) {
    assert.ok(isThinkingBudgetTier(tier.value), `${tier.value} should be a valid tier`);
  }
  assert.ok(!isThinkingBudgetTier(1234));
  assert.ok(!isThinkingBudgetTier(-1));
});

test('every tier label key is declared in i18n for both languages', () => {
  // Type declaration + English table + Chinese table = 3 occurrences.
  // Catches a tier added to the dropdown but never translated.
  const i18n = readFileSync(new URL('../src/i18n.ts', import.meta.url), 'utf8');
  for (const tier of THINKING_BUDGET_TIERS) {
    const occurrences = i18n.split(`${tier.labelKey}:`).length - 1;
    assert.equal(
      occurrences,
      3,
      `${tier.labelKey} should appear 3× in i18n.ts (type + en + zh), found ${occurrences}`,
    );
  }
});

test('the settings default matches the module constant', () => {
  const themes = readFileSync(new URL('../src/themes.ts', import.meta.url), 'utf8');
  const match = themes.match(/aiThinkingBudget:\s*([0-9]+)/);
  assert.ok(match, 'aiThinkingBudget default not found in themes.ts — did it move?');
  assert.equal(Number(match[1]), DEFAULT_THINKING_BUDGET);
});
