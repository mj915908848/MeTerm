import {
  decodeHello,
  decodeMessage,
  encodeMessage,
  ErrSessionNotFound,
  ErrKicked,
  MsgError,
  MsgHello,
  MsgOutput,
  MsgPong,
  MsgResize,
  MsgRoleChange,
  MsgSessionEnd,
  MsgSetEncoding,
  MsgMasterRequestNotify,
  MsgOscEvent,
} from './protocol';
import { DrawerManager } from './drawer';
import { filterPostResizeNewlines } from './terminal-resize';
import { applyMirror, clearMirror, enterMirror, exitMirror, isMirrored } from './viewer-mirror';
import { IpcTransport } from './terminal-transport';
import { feedThumbnail } from './terminal-thumbnail-feed';
import type { AppSettings } from './themes';
import type { ManagedTerminal } from './terminal-types';
import { trackPromptEnd } from './terminal-command-block';

/** Streaming decoders for AI output listeners, one per terminal. */
/** Mirrors protocol::PONG_RTT_UNKNOWN on the Rust side. */
const PONG_RTT_UNKNOWN = 0xFFFFFFFF;

const outputDecoders = new WeakMap<ManagedTerminal, TextDecoder>();

export interface WsCallbacks {
  scheduleSettleResize: (mt: ManagedTerminal) => void;
  getSettings: () => AppSettings | null;
  sendEncoding: (mt: ManagedTerminal, encoding: string) => void;
  getOutputListeners: (sessionId: string) => Set<(data: string) => void> | undefined;
  updateShellTitle: (mt: ManagedTerminal) => void;
  setPongTime: (sessionId: string, time: number) => void;
  getPingTimestamp: (sessionId: string) => number | undefined;
  deletePingTimestamp: (sessionId: string) => void;
  /** Handle OSC events from Rust backend (MSG_OSC_EVENT) */
  onOscEvent: (mt: ManagedTerminal, payload: Uint8Array) => void;
}

export function handleIncomingMessage(
  mt: ManagedTerminal,
  data: ArrayBuffer,
  callbacks: WsCallbacks,
  closeFn?: () => void,
): void {
  const decoded = decodeMessage(data);
  const type = decoded.type;
  const payload = decoded.payload;

  if (type === MsgHello) {
    const hello = decodeHello(payload);
    mt.clientId = hello.client_id;
    // 以非 master 身份接入(重连时会话被手机主控/跨窗口转移后新建连接):
    // 立即按 HELLO 的 PTY 尺寸进入镜像,不等主控下一次 resize(否则空窗内全错位)。
    if (hello.role && hello.role !== 'master' && hello.cols && hello.rows) {
      enterMirror(mt.id);
      applyMirror(mt, hello.cols, hello.rows);
    }
    return;
  }

  if (type === MsgOscEvent) {
    callbacks.onOscEvent(mt, payload);
    return;
  }

  if (type === MsgOutput) {
    let outData: Uint8Array | null = payload;
    if (mt._postResizeNewlineFilter > 0) {
      outData = filterPostResizeNewlines(mt, outData);
      if (!outData) return;
    }

    const outListeners = callbacks.getOutputListeners(mt.id);
    if (outListeners && outListeners.size > 0) {
      // One streaming decoder per terminal: a multi-byte UTF-8 character
      // split across frames would otherwise decode to U+FFFD.
      let decoder = outputDecoders.get(mt);
      if (!decoder) {
        decoder = new TextDecoder();
        outputDecoders.set(mt, decoder);
      }
      const text = decoder.decode(outData, { stream: true });
      outListeners.forEach(cb => cb(text));
    }

    if (mt.shellState.promptOpen) mt.terminal.write(outData, () => trackPromptEnd(mt));
    else mt.terminal.write(outData);
    feedThumbnail(mt, outData);

    if (!mt.hasOscTitle) {
      callbacks.updateShellTitle(mt);
    }
    return;
  }

  if (type === MsgResize) {
    // 下行 resize 广播:仅发给非 master(观看方)。主控 PTY 尺寸变了,
    // 镜像渲染按新尺寸 resize + 等比缩放居中(viewer-mirror)。
    // isMirrored 守卫:服务端广播按锁外 master_id 快照过滤,与夺回 master 并发时
    // 可能给刚变 master 的本端也发一份——无守卫会把主控终端重新标记成镜像,
    // resize 链路从此死锁(审查确认的 TOCTOU)。合法 viewer 必先经
    // master-lost/HELLO 进入镜像,守卫不影响正常路径。
    if (isMirrored(mt.id) && payload.length >= 4) {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      applyMirror(mt, view.getUint16(0), view.getUint16(2));
    }
    return;
  }

  if (type === MsgRoleChange) {
    const role = payload[0];
    if (mt._transferGrace) {
      if (role === 1) {
        mt._transferGrace = false;
        // grace 吞掉了 master-gained 事件,镜像状态要在这里同步退出,
        // 否则 exitMirror 永远无人调用,终端卡死在镜像缩放(审查确认)。
        if (isMirrored(mt.id)) exitMirror(mt);
      }
      return;
    }
    if (mt.ended) return;
    if (role === 0) {
      document.dispatchEvent(new CustomEvent('master-lost', { detail: { sessionId: mt.id } }));
    } else if (role === 1) {
      document.dispatchEvent(new CustomEvent('master-gained', { detail: { sessionId: mt.id } }));
    }
    return;
  }

  if (type === MsgMasterRequestNotify) {
    try {
      const decoded: unknown = JSON.parse(new TextDecoder().decode(payload));
      if (decoded === null || typeof decoded !== 'object') return;
      const d = decoded as Record<string, unknown>;
      const requesterConnGen = d.conn_gen;
      if (
        typeof d.session_id !== 'string'
        || typeof d.requester_id !== 'string'
        || typeof requesterConnGen !== 'number'
        || !Number.isSafeInteger(requesterConnGen)
        || requesterConnGen < 0
        || d.session_id !== mt.id
      ) {
        return;
      }
      document.dispatchEvent(new CustomEvent('master-request', {
        detail: {
          sessionId: d.session_id,
          requesterId: d.requester_id,
          requesterConnGen,
        },
      }));
    } catch { /* ignore malformed */ }
    return;
  }

  if (type === MsgSessionEnd) {
    console.warn(`[terminal] MsgSessionEnd received for session ${mt.id} — marking as ended`);
    clearMirror(mt.id);   // 会话终结,清镜像状态(防 Map 泄漏/同 id 复用残留)
    // payload[0]==1 = 被显式删除(手机端关闭):自动移除标签;
    // 自然退出(无 payload)保持现状——标签显示"已结束"供回看。
    if (payload.length >= 1 && payload[0] === 1) {
      document.dispatchEvent(new CustomEvent('session-deleted', { detail: { sessionId: mt.id } }));
    }
    mt.ended = true;
    mt.onStatus('ended');
    DrawerManager.notifyDisconnect(mt.id);
    if (closeFn) closeFn();
    return;
  }

  if (type === MsgPong) {
    callbacks.setPongTime(mt.id, Date.now());
    const sentTs = callbacks.getPingTimestamp(mt.id);
    if (sentTs !== undefined) {
      callbacks.deletePingTimestamp(mt.id);
      // Only SSH pongs carry a reading (the backend's round trip to the remote
      // host). A local pong is just the IPC hop to our own backend — always
      // ~0ms and not a latency worth showing. 0xFFFFFFFF = SSH but no reading
      // this time (timeout / busy), which must not count as a sample either.
      if (payload.length >= 4) {
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const rtt = view.getUint32(0);
        if (rtt !== PONG_RTT_UNKNOWN) {
          document.dispatchEvent(new CustomEvent('status-bar-pong', { detail: { sessionId: mt.id, rtt } }));
        }
      }
    }
    return;
  }

  if (type === MsgError) {
    const code = payload[0];
    if (code === ErrSessionNotFound) {
      mt.ended = true;
      mt.onStatus('notfound');
      if (closeFn) closeFn();
    } else if (code === ErrKicked) {
      mt.ended = true;
      mt.kicked = true;
      mt.onStatus('ended');
      document.dispatchEvent(new CustomEvent('client-kicked', { detail: { sessionId: mt.id } }));
      if (closeFn) closeFn();
    }
    return;
  }
}

async function connectIpc(mt: ManagedTerminal, callbacks: WsCallbacks): Promise<void> {
  mt.onStatus('connecting');
  const transport = new IpcTransport(mt.id, mt.clientId);

  transport.onmessage = (data) => {
    if (mt.ended) return;
    handleIncomingMessage(mt, data, callbacks, () => transport.close());
  };
  transport.onclose = () => {
    if (mt.transport === transport) {
      mt.transport = null;
      DrawerManager.notifyDisconnect(mt.id);
      // The backend dropped this connection (stale heartbeat while the window
      // was hidden or asleep). Re-attach with the same client id so the
      // session is not reaped behind a terminal that still looks alive.
      if (!mt.ended) scheduleIpcReconnect(mt, callbacks);
    }
  };

  try {
    await transport.connect();
    mt.reconnectAttempt = 0;
    // detach/destroy can run while the native invoke is still completing. In
    // that case no registry entry remains to close the newly created client.
    if (mt.ended) {
      transport.close();
      return;
    }
    mt.transport = transport;
    mt.clientId = transport.clientId;
    mt.onStatus('connected');
    document.dispatchEvent(new CustomEvent('meterm-terminal-connected', { detail: { sessionId: mt.id } }));
    callbacks.scheduleSettleResize(mt);

    const settings = callbacks.getSettings();
    if (settings && settings.encoding !== 'utf-8') {
      callbacks.sendEncoding(mt, settings.encoding);
    }

    DrawerManager.setTransport(mt.id, transport);
  } catch (e) {
    if (mt.ended) return;
    console.error(`[terminal] IPC connect failed for session ${mt.id}:`, e);
    if (mt.reconnectAttempt > 0 && !String(e).includes('session not found')) {
      // Reconnecting: the old client may already have been expired after the
      // grace period. Fall back to joining as a new client.
      if (String(e).includes('client not found')) mt.clientId = null;
      scheduleIpcReconnect(mt, callbacks);
      return;
    }
    mt.onStatus('disconnected');
  }
}

const IPC_MAX_RECONNECT_ATTEMPTS = 5;

function scheduleIpcReconnect(mt: ManagedTerminal, callbacks: WsCallbacks): void {
  if (mt.ended) return;
  if (mt.reconnectAttempt >= IPC_MAX_RECONNECT_ATTEMPTS) {
    mt.onStatus('disconnected');
    return;
  }
  const delay = Math.min(250 * Math.pow(2, mt.reconnectAttempt), 4000);
  mt.reconnectAttempt += 1;
  mt.onStatus('reconnecting');
  if (mt.reconnectTimer) clearTimeout(mt.reconnectTimer);
  mt.reconnectTimer = setTimeout(() => {
    mt.reconnectTimer = null;
    if (!mt.ended) void connectIpc(mt, callbacks);
  }, delay);
}

export function connectTerminal(mt: ManagedTerminal, callbacks: WsCallbacks): void {
  void connectIpc(mt, callbacks);
}
