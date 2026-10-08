import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/terminal-transport.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('terminal-transport.ts', source, ts.ScriptTarget.Latest, true);
const klass = parsed.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === 'IpcTransport');
assert.ok(klass);

test('IPC input invokes are submitted in the same order as send calls', async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let entered = 0;
  const invoke = async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === 'ipc_connect_session') {
      return JSON.stringify({ client_id: 'owner-id', conn_gen: 2, role: 'viewer', cols: 80, rows: 24 });
    }
    if (command === 'ipc_session_input') return ++entered === 1 ? first : Promise.resolve();
    return undefined;
  };
  class Channel<T> { onmessage: ((payload: T) => void) | null = null; }
  const js = ts.transpile(`${klass.getText(parsed).replace(/^export /, '')}; return IpcTransport;`, {
    module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022,
  });
  const Type = new Function('invoke', 'Channel', 'MsgInput', 'MsgResize', js)(
    invoke, Channel, 1, 2,
  ) as new (sessionId: string, clientId: string | null) => {
    connect: () => Promise<unknown>;
    send: (data: Uint8Array) => void;
  };

  const transport = new Type('session-1', 'owner-id');
  await transport.connect();
  transport.send(new Uint8Array([1, 65]));
  transport.send(new Uint8Array([1, 66]));
  await Promise.resolve();
  assert.deepEqual(calls.filter((call) => call.command === 'ipc_session_input').map((call) => call.args.data),
    [[65]], 'the second native invoke must wait for the first');
  releaseFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.filter((call) => call.command === 'ipc_session_input').map((call) => call.args.data),
    [[65], [66]]);
});
