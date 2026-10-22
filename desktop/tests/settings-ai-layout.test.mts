import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { effectivePermissionMode, PERMISSION_MODES } from '../src/ai-permission-rules.ts';

const read = (file: string) => readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');

test('a stored permission mode wins; otherwise the old trust level decides', () => {
  assert.equal(effectivePermissionMode({ aiAgentTrustLevel: 0 }), 'ask');
  assert.equal(effectivePermissionMode({ aiAgentTrustLevel: 1 }), 'acceptSafe');
  assert.equal(effectivePermissionMode({ aiAgentTrustLevel: 2 }), 'acceptAll');
  assert.equal(effectivePermissionMode({}), 'ask');
  assert.equal(effectivePermissionMode({ aiPermissionMode: 'plan', aiAgentTrustLevel: 2 }), 'plan');
  assert.deepEqual([...PERMISSION_MODES].sort(), ['acceptAll', 'acceptSafe', 'ask', 'bypass', 'plan']);
});

test('the agent, the AI bar shield and Settings all read the same permission mode', () => {
  assert.match(read('ai-agent.ts'), /effectivePermissionMode\(settingsForTools\)/);
  const shield = read('ai-capsule-trust.ts');
  assert.match(shield, /updateSettings\(\{ aiPermissionMode: mode \}\)/);
  assert.doesNotMatch(shield, /aiAgentTrustLevel/);
  assert.match(read('settings-ai-permission.ts'), /effectivePermissionMode\(current\)/);
  assert.doesNotMatch(read('settings-ai.ts'), /aiAgentTrustLevel/);
});

test('the AI page is laid out as searchable card groups', () => {
  const ai = read('settings-ai.ts');
  for (const group of ['aiGroupProviders', 'aiGroupReply', 'aiGroupAgent', 'aiGroupWebSearch']) {
    assert.match(ai, new RegExp(`createGroup\\(t\\('${group}'\\)`));
  }
  // Advanced folds away at the end of Replies instead of being its own group.
  assert.match(ai, /createGroup\(t\('aiGroupReply'\), \[\.\.\.createReplyRows\(current, update\), \.\.\.createAdvancedRows\(current, update\)\]\)/);
  assert.match(read('styles/ai-settings.css'), /aria-expanded="false"\]\) > \.ai-advanced-row \{ display: none; \}/);
  assert.match(read('settings.ts'), /key: 'ai'.*createAIPage\(current, update\), searchable: true/);
});

test('terminal-only helpers moved from the AI page to Terminal › Command Assist', () => {
  const ai = read('settings-ai.ts');
  for (const key of ['tldrEnabled', 'cmdCompletionEnabled', 'shellHookInjection']) {
    assert.doesNotMatch(ai, new RegExp(key));
    assert.match(read('settings-command-assist.ts'), new RegExp(key));
  }
  assert.match(read('settings-general.ts'), /createGroup\(t\('settingsGroupCommandAssist'\), createCommandAssistRows\(current, update\)\)/);
});

test('the shell hook hint no longer warns Windows users off', () => {
  const hints = [...read('i18n.ts').matchAll(/shellHookHint: '([^']*)'/g)].map(m => m[1]);
  assert.equal(hints.length, 2);
  for (const hint of hints) assert.doesNotMatch(hint, /Windows|ConPTY/);
});
