import type { Terminal } from '@xterm/xterm';
import type { CanvasAddon } from '@xterm/addon-canvas';
import type { FitAddon } from '@xterm/addon-fit';
import type { LigaturesAddon } from '@xterm/addon-ligatures';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { TerminalTransport } from './terminal-transport';

export type SessionStatus = 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'notfound' | 'disconnected';

/**
 * Shell-integration phase for a session's prompt.
 *
 * **Only meaningful while `shellState.hookInjected` is true.** It is advanced
 * and reset exclusively by OSC 7768 (`terminal-osc.ts`) plus the single
 * `agent_executing` write in `TerminalRegistry.sendAgentCommand`; a session
 * without the hook therefore sits at whatever it last was and must never be
 * read as if it described the screen. Every reader in the codebase is gated on
 * `hookInjected` for exactly this reason — keep it that way.
 *
 * The `user_active` member that used to exist here was removed: nothing ever
 * read it, so its write path could not affect any decision while making the
 * machine *look* like it tracked user foreground commands.
 */
export type ShellPhase = 'unknown' | 'ready' | 'agent_executing';

export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
}

export interface ManagedTerminal {
  id: string;
  title: string;
  shellTitle: string;
  hasOscTitle: boolean;
  terminal: Terminal;
  thumbnailTerminal: Terminal | null;
  fitAddon: FitAddon;
  canvasAddon: CanvasAddon | null;
  webglAddon: WebglAddon | null;
  ligaturesAddon: LigaturesAddon | null;
  container: HTMLDivElement;
  thumbnailContainer: HTMLDivElement;
  ws: WebSocket | null;
  transport: TerminalTransport | null;
  clientId: string | null;
  ended: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Port used for local WebSocket connection (updated on sidecar restart) */
  _port: number;
  /** Auth token for local WebSocket connection (updated on sidecar restart) */
  _token: string;
  resizeDebounce: ReturnType<typeof setTimeout> | null;
  settleTimers: ReturnType<typeof setTimeout>[];
  lastSentCols: number;
  lastSentRows: number;
  observer: ResizeObserver | null;
  onStatus: (status: SessionStatus) => void;
  onTitleChange: (title: string) => void;
  /** Count of \n bytes to filter from incoming data after SIGWINCH, 0 = disabled */
  _postResizeNewlineFilter: number;
  _postResizeFilterTimer: ReturnType<typeof setTimeout> | null;
  /** True once user has sent any input — disables post-resize \n filter */
  _hasUserInput: boolean;
  /** Suppress MsgRoleChange during cross-window tab transfer grace period */
  _transferGrace: boolean;
  /** Canonical remote authority metadata. Authentication stays in Rust. */
  remoteHost?: string;
  remotePort?: number;
  /** Whether this is a remote viewer session */
  isRemote?: boolean;
  /** Whether this session was kicked by the host */
  kicked?: boolean;
  /** Last reported OSC background color — used to detect actual theme change */
  _lastOscBg?: string;
  // _userScrolledUp and scroll stabilization are handled via closures
  // in terminal.ts (not stored on ManagedTerminal).
  /** Reset the scroll-area height floor so resize can shrink freely */
  _resetScrollFloor?: () => void;
  /** OSC 7766 marker resolvers — key is marker ID, value resolves with exit code */
  _oscMarkerResolvers: Map<string, (exitCode: number) => void>;
  /** Shell integration state — tracked via OSC 7768 prompt hook */
  shellState: {
    /** See ShellPhase — hook-only; never trust it on a hookless session. */
    phase: ShellPhase;
    lastExitCode: number;
    cwd: string;
    hookInjected: boolean;
    /**
     * Timestamp of the last byte that reached the terminal from the user.
     * The hookless completion heuristics read this to disqualify a
     * prompt-shaped screen tail as evidence (the prompt may be the OLD one).
     */
    lastUserInputAt: number;
    /** Last executed command reported by shell hook (fc -ln -1) */
    lastCommand: string;
    /** Absolute row where the current prompt starts (set by OSC 7768 shell event) */
    promptRow: number;
    /** Column where user input begins (after prompt text, set by OSC 7768 shell event) */
    promptCol: number;
  };
}
