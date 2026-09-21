import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * Guards for the editor tab strip's width behaviour.
 *
 * The strip shows a full `host:/path` whenever the row can hold it, and relies
 * on two things that are easy to undo by accident:
 *
 *   1. The app-wide `.title-tab` rules must be lifted for this strip. Its 340px
 *      max-width and 84px min-width are tuned for the toolbar's short connection
 *      names; left in place they clip a path no matter what the JS computes.
 *   2. The JS writes an inline `width`, which only takes effect if the tab is
 *      NOT allowed to shrink — the project already hit this once, where a flex
 *      default squeezed tabs back to their CSS minimum and silently defeated the
 *      planned widths.
 *
 * These read the sources rather than the rendered result, so they fail loudly at
 * the moment one of those invariants is broken instead of showing up as a
 * mysteriously truncated tab.
 */

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8');

const css = read('../src/styles/file-editor.css');
const editor = read('../src/file-editor.ts');

// `doesNotMatch` passes vacuously on an empty string, so prove the sources were
// actually read before relying on any negative assertion below.
test('the sources under test were really read', () => {
  assert.ok(css.length > 1000, 'file-editor.css came back suspiciously small');
  assert.ok(editor.length > 1000, 'file-editor.ts came back suspiciously small');
  assert.match(css, /\.editor-tabs-area/);
  assert.match(editor, /function applyEditorTabWidths/);
});

/** Body of the first rule whose selector matches `selector`. */
const ruleBody = (source: string, selector: string): string => {
  const match = source.match(
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`),
  );
  assert.ok(match, `no CSS rule found for "${selector}"`);
  return match[1];
};

// ── CSS must lift the app-wide caps ──

test('editor tabs win over the app-wide max-width', () => {
  const body = ruleBody(css, '.editor-tabs-area .title-tab');
  assert.match(
    body,
    /max-width:\s*none/,
    'a 340px cap would clip a long path regardless of the planned width',
  );
});

test('editor tabs cannot be squeezed below the width the JS planned', () => {
  const body = ruleBody(css, '.editor-tabs-area .title-tab');
  assert.match(
    body,
    /flex:\s*0\s+0\s+auto/,
    'without flex: 0 0 auto the inline width is overridden and the plan is ignored',
  );
});

test('the CSS floor stays out of the way of the JS floors', () => {
  const body = ruleBody(css, '.editor-tabs-area .title-tab');
  assert.match(
    body,
    /min-width:\s*0/,
    'a CSS min-width would be a second floor that planTabWidths does not know about',
  );
});

test('the strip can still scroll once every tab is at its floor', () => {
  const body = ruleBody(css, '.editor-tabs-area');
  assert.match(body, /overflow-x:\s*(auto|scroll)/);
});

// ── JS must use the shared allocation and keep the marquee out ──

test('widths come from the shared water-filling allocator', () => {
  assert.match(
    editor,
    /planTabWidths\(\{/,
    'the editor must reuse tab-layout so both tab strips shrink the same way',
  );
});

test('the planned widths are applied on render and on resize', () => {
  assert.match(editor, /applyEditorTabWidths\(\);/);
  assert.match(editor, /addEventListener\('resize'/);
});

test('the marquee stays out of the editor strip', () => {
  assert.doesNotMatch(editor, /syncTabMarqueeIn/);
  assert.doesNotMatch(
    editor,
    /title-tab-text primary/,
    'a .primary span would re-arm syncTabMarqueeFor and reintroduce the marquee',
  );
});
