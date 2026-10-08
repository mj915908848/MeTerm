import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/terminal-transport.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('terminal-transport.ts', source, ts.ScriptTarget.Latest, true);
const klass = parsed.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === 'IpcTransport');
assert.ok(klass);

function makeTransport(invokeInput?: () => Promise<void>) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  class Channel<T> { onmessage: ((payload: T) => void) | null = null; }
  const invoke = async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === 'ipc_connect_session') return JSON.stringify({ client_id: 'owner-id', conn_gen: 2, role: 'viewer', cols: 80, rows: 24 });
    if (command === 'ipc_session_input') return invokeInput?.();
    return undefined;
  };
  const js = ts.transpile(`${klass.getText(parsed).replace(/^export /, '')}; return IpcTransport;`, {
    module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022,
  });
  const Type = new Function('invoke', 'Channel', 'MsgInput', 'MsgResize', js)(
    invoke, Channel, 1, 2,
  ) as new (sessionId: string, clientId: string | null) => {
    connect: () => Promise<unknown>;
    send: (data: Uint8Array) => void;
    close: () => void;
  };
  return { Type, calls };
}

test('IPC reconnect carries the original owner ID and every action is generation-bound', async () => {
  const h = makeTransport();
  const transport = new h.Type('session-1', 'owner-id');
  await transport.connect();
  transport.send(new Uint8Array([1, 65]));
  transport.close();
  await Promise.resolve();

  assert.equal(h.calls[0].command, 'ipc_connect_session');
  assert.equal(h.calls[0].args.clientId, 'owner-id');
  for (const call of h.calls.filter((call) => call.command !== 'ipc_connect_session')) {
    assert.equal(call.args.clientId, 'owner-id');
    assert.equal(call.args.connGen, 2, `${call.command} must not borrow a replacement connection`);
  }
});
