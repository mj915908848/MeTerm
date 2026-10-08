import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { runTools } from '../src/ai-tool-orchestrator.ts';

const calls = Array.from({ length: 4 }, (_, i) => ({
  id: `call-${i + 1}`,
  type: 'function' as const,
  function: { name: 'test_tool', arguments: '{}' },
}));

// Execute the real result-draining loop. Importing ToolAgent in Node pulls in
// the extensionless desktop/Tauri graph, so isolate this AST statement while
// supplying only its message history and callbacks.
function drainResults(results: Array<{ callId: string; toolName: string; result: string; isError: boolean }>, aborted = false) {
  const source = readFileSync(new URL('../src/ai-agent.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('ai-agent.ts', source, ts.ScriptTarget.Latest, true);
  let loop: ts.ForOfStatement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isForOfStatement(node) && node.expression.getText(parsed) === 'results'
      && node.initializer.getText(parsed) === 'const r') loop = node;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(loop, 'ToolAgent result-draining loop must exist');
  const statements = (loop.parent as ts.Block).statements;
  const fromLoop = statements.indexOf(loop);
  const throughStop = statements.findIndex((node, i) => i > fromLoop && node.getText(parsed).startsWith('if (tooManyToolErrors)'));
  assert.ok(throughStop > fromLoop, 'error stop must follow result drain');
  const body = ts.transpile(statements.slice(fromLoop, throughStop + 1).map(node => node.getText(parsed)).join('\n'),
    { target: ts.ScriptTarget.ES2022 });
  const errors: Error[] = [];
  let aborts = 0;
  const agent = { messages: [] as Array<{ tool_call_id: string }>, abortController: {}, aborted };
  const callbacks = { onError: (error: Error) => errors.push(error), onToolResult: () => {}, onAborted: () => aborts++ };
  const drain = new Function('results', 'callbacks', 'MAX_CONSECUTIVE_ERRORS',
    'isTerminalInterruption', `let consecutiveErrors = 0; let terminalInterrupted = false; let tooManyToolErrors = false; let iteration = 0; ${body}`);
  drain.call(agent, results, callbacks, 3, () => false);
  return { agent, errors, aborts };
}

test('third tool error stops the run only after all four results are written', () => {
  const { agent, errors } = drainResults(calls.map((call, i) => ({
    callId: call.id, toolName: call.function.name,
    result: i < 3 ? 'failed' : 'completed', isError: i < 3,
  })));
  assert.deepEqual(agent.messages.map(message => message.tool_call_id), calls.map(call => call.id));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Too many consecutive tool errors/);
});

test('abort retains its callback after writing executed and cancelled results', () => {
  const { agent, errors, aborts } = drainResults(calls.map((call, i) => ({
    callId: call.id, toolName: call.function.name,
    result: i === 0 ? 'completed' : 'Execution aborted by user', isError: i > 0,
  })), true);
  assert.deepEqual(agent.messages.map(message => message.tool_call_id), calls.map(call => call.id));
  assert.equal(aborts, 1);
  assert.equal(errors.length, 0);
});

test('abort between serial tools supplies a cancellation result for every pending call', async () => {
  let aborted = false;
  const executed: string[] = [];
  const handler = { isConcurrencySafe: false } as any;
  const results = await runTools(calls, () => handler, async call => {
    executed.push(call.id);
    aborted = true;
    return { result: 'completed', isError: false };
  }, () => aborted);
  assert.deepEqual(executed, [calls[0].id]);
  assert.deepEqual(results.map(result => result.callId), calls.map(call => call.id));
  assert.equal(results[0].isError, false);
  for (const result of results.slice(1)) {
    assert.equal(result.isError, true);
    assert.match(result.result as string, /abort|cancel/i);
  }
});
