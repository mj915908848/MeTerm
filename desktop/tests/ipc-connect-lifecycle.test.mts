import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/terminal-websocket.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('terminal-websocket.ts', source, ts.ScriptTarget.Latest, true);
const connectIpcNode = file.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'connectIpc');
assert.ok(connectIpcNode?.body);

function harness() {
  let finishConnect!: () => void;
  const pending = new Promise<void>((resolve) => { finishConnect = resolve; });
  const transports: Array<{ closed: boolean; clientId: string; onmessage: unknown; onclose: unknown; connect: () => Promise<void>; close: () => void }> = [];
  const statuses: string[] = [];
  const events: string[] = [];
  class FakeTransport {
    clientId = 'ipc-owner';
    closed = false;
    onmessage: unknown = null;
    onclose: unknown = null;
    constructor(_sessionId: string) { transports.push(this); }
    async connect() { await pending; }
    close() { this.closed = true; }
  }
  const js = ts.transpile(`${connectIpcNode.getText(file)}; return connectIpc;`, {
    module: ts.ModuleKind.None,
    target: ts.ScriptTarget.ES2022,
  });
  const document = { dispatchEvent: (event: { type: string }) => events.push(event.type) };
  class CustomEvent {
    type: string;
    options: unknown;
    constructor(type: string, options: unknown) { this.type = type; this.options = options; }
  }
  const connectIpc = new Function('IpcTransport', 'DrawerManager', 'document', 'CustomEvent', 'handleIncomingMessage', js)(
    FakeTransport,
    { setTransport() {}, notifyDisconnect() {} },
    document,
    CustomEvent,
    () => {},
  ) as (mt: Record<string, unknown>, callbacks: Record<string, unknown>) => Promise<void>;
  const mt: Record<string, unknown> = {
    id: 'session-1', ended: false, transport: null, clientId: null,
    reconnectAttempt: 0, onStatus: (status: string) => statuses.push(status),
  };
  const callbacks = {
    scheduleSettleResize() {}, getSettings: () => null,
    sendEncoding() {}, onReconnectNeeded() {},
  };
  return { connectIpc, mt, callbacks, transports, statuses, events, finishConnect };
}

test('late IPC connect after teardown closes its native client without reviving terminal', async () => {
  const h = harness();
  const connecting = h.connectIpc(h.mt, h.callbacks);
  h.mt.ended = true; // detach/destroy marks ended while mt.transport is still null
  h.finishConnect();
  await connecting;

  assert.equal(h.transports[0].closed, true);
  assert.equal(h.mt.transport, null);
  assert.equal(h.mt.clientId, null);
  assert.deepEqual(h.statuses, ['connecting']);
  assert.deepEqual(h.events, []);
});
