import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { CompletionIndex } from '../src/cmd-completion-data.ts';

const terminalSource = readFileSync(
  new URL('../src/terminal.ts', import.meta.url),
  'utf8',
);
const completionSource = readFileSync(
  new URL('../src/cmd-completion.ts', import.meta.url),
  'utf8',
);

test('terminal completion attachment does not race asynchronous index loading', () => {
  assert.doesNotMatch(
    terminalSource,
    /cmdCompletionEnabled\s*&&\s*globalCompletionIndex\.ready/,
  );
  assert.match(
    terminalSource,
    /this\._syncInlineCompletion\(mt, !!this\.settings\?\.cmdCompletionEnabled\)/,
  );
});

test('settings changes update completion on terminals that are already open', () => {
  assert.match(
    terminalSource,
    /this\._syncInlineCompletion\(mt, settings\.cmdCompletionEnabled\)/,
  );
  assert.match(terminalSource, /completion\.attach\(\)/);
  assert.match(terminalSource, /existing\.detach\(\)/);
});

test('an attached completion index becomes useful after async data arrives', () => {
  const index = new CompletionIndex();
  assert.equal(index.getBestMatch('gi'), null);

  index.loadTldr(['git', 'gist']);
  assert.equal(index.getBestMatch('gi'), 'git');

  index.loadHistory(['git status', 'git status', 'git switch main']);
  assert.equal(index.getBestMatch('git s'), 'git status');
});

test('ghost rendering does not depend on the removed xterm _optionsService field', () => {
  assert.doesNotMatch(completionSource, /_optionsService/);
  assert.match(completionSource, /this\.terminal\.options\.fontSize/);
  assert.match(completionSource, /screenRect\.width\s*\/\s*this\.terminal\.cols/);
});

test('transferred terminals attach completion after terminal open', () => {
  const openAndConnect = terminalSource.slice(
    terminalSource.indexOf('openAndConnect('),
    terminalSource.indexOf('reconnectAll('),
  );
  assert.match(
    openAndConnect,
    /this\._syncInlineCompletion\(mt, !!this\.settings\?\.cmdCompletionEnabled\)/,
  );
});
