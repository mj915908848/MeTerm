/**
 * In-memory event contract between a main MeTerm window and the editor window.
 * File contents and save requests must never be persisted in localStorage.
 */

export const EDITOR_WINDOW_LABEL = 'editor';

export const EDITOR_PING_EVENT = 'meterm-editor-ping';
export const EDITOR_PONG_EVENT = 'meterm-editor-pong';
export const EDITOR_OPEN_EVENT = 'meterm-editor-open';
export const EDITOR_CONTENT_EVENT = 'meterm-editor-content';
export const EDITOR_SAVE_REQUEST_EVENT = 'meterm-editor-save-request';
export const EDITOR_SAVE_RESULT_EVENT = 'meterm-editor-save-result';
export const EDITOR_TAB_CLOSED_EVENT = 'meterm-editor-tab-closed';
export const EDITOR_WINDOW_CLOSED_EVENT = 'meterm-editor-window-closed';
export const EDITOR_DISCONNECTED_EVENT = 'meterm-editor-disconnected';

/** Matches the server-side bounded editor read limit. */
export const MAX_EDITOR_FILE_BYTES = 50 * 1024 * 1024;

export interface EditorPing {
  ownerLabel: string;
  requestId: string;
}

export interface EditorPong {
  requestId: string;
  /**
   * Identifies the editor *page load*, not the window. Recreated whenever the
   * view is rebuilt (a reload, or the webview restarting), which is how the
   * window that owns the tabs finds out its view is gone. Optional so a build
   * that predates it still answers pings.
   */
  viewId?: string;
}

export interface EditorOpen {
  tabId: string;
  ownerLabel: string;
  sessionId: string;
  filePath: string;
  fileName: string;
  host: string;
  isImage: boolean;
  mimeType: string;
}

export interface EditorContent {
  tabId: string;
  content?: string;
  error?: string;
  isImage?: boolean;
  mimeType?: string;
}

export interface EditorSaveRequest {
  tabId: string;
  content: string;
}

export interface EditorSaveResult {
  tabId: string;
  success: boolean;
  error?: string;
}

export interface EditorTabClosed {
  tabId: string;
}

export interface EditorDisconnected {
  tabId: string;
}

export function isSafeEditorWindowLabel(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

export function isValidEditorNonce(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** How a pong's view id relates to the view the caller last spoke to. */
export type EditorViewContact = 'ignore' | 'known' | 'recreated';

/**
 * Decide what a pong's `viewId` means for the caller.
 *
 * `knownViewId` is what the caller recorded last time; `incoming` is whatever
 * the editor sent and is therefore untrusted. A missing or malformed id is
 * ignored rather than treated as a change — an older editor build, or a view
 * that could not mint a UUID, must never be mistaken for a fresh view, because
 * the caller reacts to 'recreated' by discarding its record of every open tab.
 */
export function classifyEditorViewContact(
  knownViewId: string | null,
  incoming: unknown,
): EditorViewContact {
  if (!isValidEditorNonce(incoming)) return 'ignore';
  if (knownViewId === null) return 'known';
  return incoming === knownViewId ? 'known' : 'recreated';
}

export function editorTextFitsLimit(value: string): boolean {
  return new TextEncoder().encode(value).byteLength <= MAX_EDITOR_FILE_BYTES;
}

interface EditorStorage {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

/** Remove content/path values left by the retired localStorage bridge. */
export function purgeLegacyEditorStorage(storage: EditorStorage): void {
  const sensitiveKey = /^meterm-editor-(?:pending|closed|(?:content|save|savereq|disconnected)-)/;
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (key && sensitiveKey.test(key)) storage.removeItem(key);
  }
}
