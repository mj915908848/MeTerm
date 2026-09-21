import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  CONTEXT_CHARS_PER_LINE,
  DEFAULT_CONTEXT_LINES,
  SYSTEM_CONTEXT_CHARS,
  excerptForPane,
} from '../src/ai-context-budget.ts';

/** A pane whose output is `count` numbered lines. */
const numberedLines = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

test('excerptForPane keeps only the last maxLines lines', () => {
  const out = excerptForPane(numberedLines(10), 3, 10_000);
  assert.equal(out, 'line 8\nline 9\nline 10');
});

test('excerptForPane returns the whole pane when it is shorter than the budget', () => {
  assert.equal(excerptForPane('a\nb', 50, 10_000), 'a\nb');
});

test('excerptForPane treats a non-positive budget as take nothing', () => {
  const raw = 'a\nb\nc';
  assert.equal(excerptForPane(raw, 0, 10_000), '');
  assert.equal(excerptForPane(raw, -1, 10_000), '');
  assert.equal(excerptForPane(raw, 10, 0), '');
  assert.equal(excerptForPane(raw, 10, -5), '');
  assert.equal(excerptForPane('', 10, 10_000), '');
});

test('lines are selected before characters', () => {
  // Four 30-char lines. Asking for 2 lines must yield the last two WHOLE
  // lines, not a character-sliced tail of the joined blob.
  const rows = ['a', 'b', 'c', 'd'].map((c) => c.repeat(30));
  const out = excerptForPane(rows.join('\n'), 2, 10_000);
  assert.equal(out, `${rows[2]}\n${rows[3]}`);
});

test('one oversized line cannot consume more than its per-line share', () => {
  const out = excerptForPane('x'.repeat(50_000), 1, 10_000);
  assert.equal(out.length, CONTEXT_CHARS_PER_LINE);
});

test('maxChars wins when it is tighter than the line-derived cap', () => {
  const rows = Array.from({ length: 5 }, () => 'y'.repeat(100));
  const out = excerptForPane(rows.join('\n'), 5, 120);
  assert.equal(out.length, 120);
});

test('the per-pane cap never exceeds maxLines × CONTEXT_CHARS_PER_LINE', () => {
  const rows = Array.from({ length: 40 }, () => 'z'.repeat(500));
  // maxChars is deliberately absurd here; the line-derived cap must be
  // the one that binds, otherwise a huge pool share would pull in the
  // whole scrollback.
  const out = excerptForPane(rows.join('\n'), 4, 1_000_000);
  assert.equal(out.length, 4 * CONTEXT_CHARS_PER_LINE);
});

// ─── Guard rails against the regression this module was written for ───
// The settings slider used to be wired to nothing: capture was pinned at
// 80 lines, rendering at 3 lines / 250 chars, and the user's value was
// read by no one. These tests fail loudly if any of that comes back.

test('the default line count is representable by the settings slider', () => {
  const settings = readFileSync(
    new URL('../src/settings-ai.ts', import.meta.url),
    'utf8',
  );
  const match = settings.match(
    /ai-context-slider'\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)/,
  );
  assert.ok(match, 'ai-context-slider row not found in settings-ai.ts — did it move?');
  const [min, max] = [Number(match[1]), Number(match[2])];
  assert.ok(
    DEFAULT_CONTEXT_LINES >= min && DEFAULT_CONTEXT_LINES <= max,
    `DEFAULT_CONTEXT_LINES (${DEFAULT_CONTEXT_LINES}) is outside the slider range ` +
      `${min}–${max}: the slider would clamp the stored value and display a ` +
      'different number from the one actually used.',
  );
});

test('the agent loop reads aiContextLines instead of a hardcoded constant', () => {
  const agent = readFileSync(
    new URL('../src/ai-agent.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    agent,
    /settings\.aiContextLines/,
    'ai-agent.ts no longer reads settings.aiContextLines — the setting became a no-op again',
  );
  assert.doesNotMatch(
    agent,
    /systemContextLines/,
    'ai-agent.ts still references the retired systemContextLines constant',
  );
});

test('the pane excerpt is no longer hardcoded to 3 lines / 250 chars', () => {
  const ctx = readFileSync(
    new URL('../src/ai-agent-context.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    ctx,
    /\.slice\(0,\s*250\)/,
    'ai-agent-context.ts hardcodes the 250-char excerpt cap again',
  );
  assert.match(
    ctx,
    /excerptForPane\(/,
    'ai-agent-context.ts no longer routes pane excerpts through excerptForPane',
  );
});

test('the shared pool can hold at least one pane at the default budget', () => {
  assert.ok(SYSTEM_CONTEXT_CHARS > 0);
  assert.ok(
    SYSTEM_CONTEXT_CHARS >= DEFAULT_CONTEXT_LINES * CONTEXT_CHARS_PER_LINE,
    'the terminal-context pool is too small to hold a single pane at the default line budget',
  );
});
