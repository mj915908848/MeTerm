import { invoke, Channel } from '@tauri-apps/api/core';
import { MsgInput, MsgResize } from './protocol';
import type { ManagedTerminal } from './terminal-types';

export interface TerminalTransport {
  send(data: Uint8Array): void;
  close(): void;
  readonly connected: boolean;
  onmessage: ((data: ArrayBuffer) => void) | null;
  onclose: (() => void) | null;
}

/** Backend error meaning this IPC connection was dropped server-side
 *  (`IPC_CLIENT_STALE` in `commands/ipc_terminal.rs`). */
export const IPC_CLIENT_STALE = 'ipc-client-stale';

export function isIpcClientStaleError(error: unknown): boolean {
  return String(error).includes(IPC_CLIENT_STALE);
}

export class IpcTransport implements TerminalTransport {
  private _connected = false;
  private _sessionId: string;
  private _clientId: string | null = null;
  private _connGen: number | null = null;
  /** Tauri commands can execute concurrently; terminal bytes must not. */
  private _inputQueue: Promise<void> = Promise.resolve();
  /** Per-transfer queues to serialize ipc_session_control invokes per transferId */
  private _controlQueues: Map<number, Promise<void>> = new Map();
  onmessage: ((data: ArrayBuffer) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(sessionId: string, private readonly reconnectClientId: string | null = null) { this._sessionId = sessionId; }

  get connected(): boolean { return this._connected; }
  get clientId(): string | null { return this._clientId; }

  async connect(): Promise<{ client_id: string; role: string; cols: number; rows: number }> {
    // The backend sends raw bytes (`InvokeResponseBody::Raw`), which arrive as
    // an ArrayBuffer. Accept the old number[] shape too, defensively.
    const channel = new Channel<ArrayBuffer | ArrayBufferView | number[]>();
    channel.onmessage = (payload) => {
      if (!this.onmessage) return;
      if (payload instanceof ArrayBuffer) {
        this.onmessage(payload);
      } else if (ArrayBuffer.isView(payload)) {
        const view = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
        this.onmessage(view.slice().buffer);
      } else {
        this.onmessage(new Uint8Array(payload).buffer);
      }
    };

    const raw = await invoke<string>('ipc_connect_session', {
      sessionId: this._sessionId,
      clientId: this.reconnectClientId,
      onOutput: channel,
    });
    const hello = JSON.parse(raw);
    this._clientId = hello.client_id;
    this._connGen = hello.conn_gen;
    this._connected = true;
    return hello;
  }

  send(data: Uint8Array): void {
    if (!this._connected || !this._clientId || this._connGen === null) return;
    const msgType = data[0];
    const payload = Array.from(data.slice(1));

    if (msgType === MsgInput) {
      const clientId = this._clientId;
      const connGen = this._connGen;
      this._inputQueue = this._inputQueue.then(() =>
        invoke('ipc_session_input', {
          sessionId: this._sessionId,
          clientId,
          connGen,
          data: payload,
        }) as Promise<void>
      ).catch((error) => this.handleInvokeError('IPC input error:', error));
    } else if (msgType === MsgResize) {
      if (payload.length >= 4) {
        const cols = (payload[0] << 8) | payload[1];
        const rows = (payload[2] << 8) | payload[3];
        void invoke('ipc_session_resize', {
          sessionId: this._sessionId,
          clientId: this._clientId,
          connGen: this._connGen,
          cols, rows,
        }).catch((error) => this.handleInvokeError('IPC resize error:', error));
      }
    } else {
      // Per-transfer queues to guarantee ordering within each transfer while
      // allowing different transfers to proceed in parallel.
      let queueKey = 0;
      if ((msgType === 0x0c || msgType === 0x0d || msgType === 0x0e || msgType === 0x14 || msgType === 0x15
           || msgType === 0x20 || msgType === 0x21 || msgType === 0x22) && payload.length >= 4) {
        if (msgType === 0x0d) {
          // Upload chunk: payload starts with [4B transferId]
          queueKey = (payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3];
        } else {
          // JSON payloads: try parse transferId
          try {
            const json = JSON.parse(new TextDecoder().decode(new Uint8Array(payload)));
            queueKey = json.transferId || 0;
          } catch { queueKey = 0; }
        }
      }

      let queue = this._controlQueues.get(queueKey) || Promise.resolve();
      queue = queue.then(() =>
        invoke('ipc_session_control', {
          sessionId: this._sessionId,
          clientId: this._clientId,
          connGen: this._connGen,
          msgType,
          payload,
        }) as Promise<void>
      ).catch(err => this.handleInvokeError('IPC control error:', err));
      this._controlQueues.set(queueKey, queue);
    }
  }

  /** The backend dropped this connection (it no longer accepts our frames
   *  and stopped sending output). Surface it as a close so the owner can
   *  reconnect, instead of leaving a terminal that silently ignores input. */
  private handleInvokeError(label: string, error: unknown): void {
    if (!isIpcClientStaleError(error)) {
      console.error(label, error);
      return;
    }
    if (!this._connected) return;
    this._connected = false;
    this._clientId = null;
    this._connGen = null;
    this.onclose?.();
  }

  close(): void {
    if (this._connected && this._clientId && this._connGen !== null) {
      void invoke('ipc_disconnect_session', {
        sessionId: this._sessionId,
        clientId: this._clientId,
        connGen: this._connGen,
      });
    }
    this._connected = false;
    this._clientId = null;
    this._connGen = null;
  }
}

export function sendToTerminal(mt: ManagedTerminal, data: Uint8Array): void {
  if (mt.transport && mt.transport.connected) {
    mt.transport.send(data);
  } else if (mt.ws && mt.ws.readyState === WebSocket.OPEN) {
    mt.ws.send(data);
  }
}
