import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = (name: string): string =>
  fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

// The delete confirmation is a modal appended to <body>, so a click on it is
// "outside" every panel. The document-level handler that closes the chat history
// treated it that way, so confirming a deletion closed the history view and
// bounced the panel back to the chat pane. The guard must run before the close.
test('the chat-history outside-click handler ignores clicks inside a danger modal', () => {
  const source = read('ai-capsule.ts');
  const start = source.indexOf("document.addEventListener('click', (e) => {");
  assert.ok(start >= 0, 'the chat-history outside-click handler was not found');
  const end = source.indexOf('this.closeChatHistory(instance);', start);
  assert.ok(end > start, 'the handler no longer calls closeChatHistory(instance)');

  const body = source.slice(start, end);
  const guard = body.indexOf('.ai-danger-overlay');
  assert.ok(guard >= 0, "the handler must skip clicks that land inside '.ai-danger-overlay'");
  assert.ok(
    guard < body.indexOf('if (instance.element.contains(target)) return;'),
    'the modal guard must sit with the other early returns, before the close',
  );
});

// Dimming the row's delete button kept it on screen for every row; the rows are
// only readable as labels when it stays out of the way until the row is hovered.
// It must still be reachable from the keyboard, and must not swallow clicks while
// it is invisible.
test('the conversation delete button is hidden until its row is hovered', () => {
  const css = read('styles/ai-bar.css');
  const start = css.indexOf('.ai-chat-hist-delete {');
  assert.ok(start >= 0, '.ai-chat-hist-delete was not found in styles/ai-bar.css');
  const block = css.slice(start, css.indexOf('}', start));

  assert.match(block, /opacity:\s*0;/, 'the delete button must start invisible');
  assert.match(
    block,
    /pointer-events:\s*none;/,
    'an invisible button must not receive clicks aimed at the row',
  );

  const reveal = css.indexOf('.ai-chat-hist-row:hover .ai-chat-hist-delete');
  assert.ok(reveal >= 0, 'the delete button must be revealed when its row is hovered');
  const revealBlock = css.slice(reveal, css.indexOf('}', reveal));
  assert.match(revealBlock, /opacity:\s*1;/, 'hovering the row must reveal the button');
  assert.match(
    revealBlock,
    /pointer-events:\s*auto;/,
    'a revealed button must be clickable again',
  );
  assert.ok(
    revealBlock.includes(':focus-visible'),
    'the reveal rule must also cover keyboard focus, or deletion becomes keyboard-unreachable',
  );
});
