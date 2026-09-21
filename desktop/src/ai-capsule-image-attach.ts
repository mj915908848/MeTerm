// ─── AI Capsule: Image Attachment Helpers ──────────────────
// Lets the user attach images to their next chat message by:
//   • Pasting an image from the clipboard (Ctrl+V / Cmd+V)
//   • Drag-dropping an image file onto the AI bar or chat panel
//
// Attached images show up as dismissible thumbnails in a strip
// above the AI bar, and ride along as multimodal content parts in
// the next send_to_llm call.

import { invoke } from '@tauri-apps/api/core';
import type { AttachedImage, AICapsuleInstance } from './ai-capsule-types';
import { openImageLightbox } from './ai-image-lightbox';
import {
  ALLOWED_IMAGE_MIMES,
  MAX_IMAGE_RAW_BYTES,
  MAX_IMAGES,
  MIN_LONGEST_EDGE,
  base64DecodedBytes,
  evaluateAdmission,
  planShrink,
  sumEncodedBytes,
} from './ai-image-budget';
import { showToast } from './notify';
import {
  attachFileToInstance,
  pickAttachmentFiles as pickAttachmentFilesImpl,
  isImageFile,
} from './ai-capsule-file-attach';

// ── Instance registry for the document-level paste handler ──
//
// We register a single capture-phase paste listener on `document` and
// dispatch the event to whichever AICapsuleInstance owns the focused
// element. This is necessary because:
//
//   • <input type="text"> is unreliable for image paste in WebKit /
//     Tauri WebView (system clipboard layer often hides image data
//     from text inputs entirely).
//   • The side-panel <textarea> is created lazily on layout switch,
//     so wiring a per-instance listener at create() time misses it.
//   • Drag-and-drop on the AI bar div works fine without registry.

const _instanceRoots: Array<{ root: HTMLElement; instance: AICapsuleInstance }> = [];
let _globalPasteWired = false;

/**
 * Optional fallback used when the paste / Cmd+V target isn't inside
 * any registered root (e.g. user has document.body focused but the
 * UI is in side mode and clearly intends to paste into the agent).
 * The capsule manager registers this on startup.
 */
let _activeInstanceGetter: (() => AICapsuleInstance | null) | null = null;
export function setActiveInstanceGetter(getter: () => AICapsuleInstance | null): void {
  _activeInstanceGetter = getter;
}

function wireGlobalPasteOnce(): void {
  if (_globalPasteWired) return;
  _globalPasteWired = true;

  // ── Keyboard-driven fallback (the hard case) ──────────────
  // WKWebView (Tauri's macOS web engine) does NOT fire a `paste`
  // event when the system pasteboard contains an NSImage from a
  // screenshot — the keystroke is consumed before any web event
  // is dispatched. We work around this by listening for Cmd/Ctrl-V
  // at the keydown level and proactively asking Rust whether the
  // clipboard has an image. If it does, we attach it; otherwise
  // we do nothing and let the original Cmd+V proceed normally
  // (so plain text paste keeps working).
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const isPasteCombo =
      (e.key === 'v' || e.key === 'V') &&
      (e.metaKey || e.ctrlKey) &&
      !e.altKey && !e.shiftKey;
    if (!isPasteCombo) return;

    const target = e.target as Node | null;
    if (!target) return;
    // Require the keystroke to land inside a registered AI bar / side
    // panel root. We previously fell back to "the currently active
    // instance" when no root owned the target, but that meant Cmd+V in
    // the terminal would silently pull a screenshot from the system
    // clipboard into the AI bar — confusing and definitely not what the
    // user asked for. AI bar paste must be intentional.
    const instance = findOwningInstance(target);
    if (!instance) return;

    // Fire-and-forget: if Rust finds an image we attach it.
    // We do NOT preventDefault — that way, if the user actually
    // had text in the clipboard, the textarea still receives it
    // via the standard paste pipeline.  Worst case: an image and
    // a text are both pasted, which is fine.
    void tryReadClipboardImageNative(instance);
  }, true);

  document.addEventListener('paste', (e: ClipboardEvent) => {
    // Find which instance owns the paste target. We walk up from
    // the event target until we hit a registered AI bar / side panel.
    const target = e.target as Node | null;
    if (!target) return;
    const instance = findOwningInstance(target);
    if (!instance) return;

    const dt = e.clipboardData;
    const imgFiles: File[] = [];
    if (dt) {
      for (const item of Array.from(dt.items)) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f && ALLOWED_MIMES.has(f.type)) imgFiles.push(f);
        }
      }
      // Some webkit builds expose images via dt.files even when items is empty.
      if (imgFiles.length === 0 && dt.files && dt.files.length > 0) {
        for (const f of Array.from(dt.files)) {
          if (ALLOWED_MIMES.has(f.type)) imgFiles.push(f);
        }
      }
    }

    if (imgFiles.length > 0) {
      e.preventDefault();
      for (const f of imgFiles) {
        void attachBlobToInstance(instance, f, f.name);
      }
      return;
    }

    // ── Fallback path for WKWebView ──
    // macOS WKWebView never exposes screenshot images on the
    // clipboardData object — when the user does Cmd+V on a
    // pasteboard image, the event fires with empty `items`.  We
    // detect this case (paste fired but no plain text either) and
    // ask Rust to read the system pasteboard directly.
    const hasText = dt && Array.from(dt.types).includes('text/plain');
    if (hasText) return; // genuine text paste — let it proceed

    // No image, no text → almost certainly a binary clipboard the
    // webview can't see. Try the native fallback.
    void tryReadClipboardImageNative(instance);
  }, true);
}

/**
 * Ask the Rust side to read the system clipboard for an image and
 * attach it to the given instance. Used as a fallback for WKWebView
 * which doesn't expose screenshot bytes via the standard paste API.
 */
async function tryReadClipboardImageNative(instance: AICapsuleInstance): Promise<void> {
  let result: {
    data: string | null;
    media_type: string | null;
    width: number;
    height: number;
  };
  try {
    result = await invoke<{
      data: string | null;
      media_type: string | null;
      width: number;
      height: number;
    }>('read_clipboard_image');
  } catch {
    // Silently ignore — fall back to file picker / drag-drop UX.
    return;
  }
  if (!result.data || !result.media_type) return;

  // The bridge hands back base64 PNG plus the pasteboard's pixel size, so the
  // budget gate can weigh it — and shrink it — without decoding it first.
  // This path used to skip every check and enqueue whatever it got.
  await admitImage(instance, {
    mediaType: result.media_type,
    data: result.data,
    rawBytes: base64DecodedBytes(result.data),
    label: `clipboard-${result.width}x${result.height}.png`,
    width: result.width,
    height: result.height,
  });
}

/**
 * Manually trigger the native clipboard read. Wired to the "paste
 * image" toolbar button so users can attach a screenshot when
 * neither the paste event nor drag-drop is convenient.
 */
export async function triggerClipboardImagePaste(
  instance: AICapsuleInstance,
): Promise<boolean> {
  const before = instance.pendingImages.length;
  await tryReadClipboardImageNative(instance);
  return instance.pendingImages.length > before;
}

/**
 * Open a system file picker and attach the chosen image(s).
 * Returns the count of images successfully attached.
 */
export async function pickImageFiles(
  instance: AICapsuleInstance,
): Promise<number> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selection = await open({
      multiple: true,
      filters: [
        {
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
        },
      ],
    });
    if (!selection) return 0;
    const paths = Array.isArray(selection) ? selection : [selection];

    let attached = 0;
    for (const path of paths) {
      const fileName = String(path).split(/[/\\]/).pop() || 'image';
      const ext = fileName.toLowerCase().split('.').pop() || 'png';
      const mediaType =
        ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
        ext === 'webp' ? 'image/webp' :
        ext === 'gif' ? 'image/gif' :
        'image/png';

      let bytes: number[];
      try {
        bytes = await invoke<number[]>('agent_read_file_bytes', {
          path,
          maxBytes: MAX_IMAGE_RAW_BYTES,
        });
      } catch {
        // The bridge refuses rather than truncates, so a failure here means
        // the file is over the cap (or unreadable). Say so instead of
        // dropping it silently, which is what used to happen.
        showToast({
          title: 'Image not attached',
          body: `"${fileName}" could not be read — the limit is ${Math.round(
            MAX_IMAGE_RAW_BYTES / (1024 * 1024),
          )} MB per image.`,
        });
        continue;
      }

      const u8 = new Uint8Array(bytes);
      const ok = await admitImage(instance, {
        mediaType,
        data: encodeBase64(u8),
        rawBytes: u8.length,
        label: fileName,
      });
      if (ok) attached++;
    }
    return attached;
  } catch {
    return 0;
  }
}

function findOwningInstance(target: Node): AICapsuleInstance | null {
  for (let cur: Node | null = target; cur; cur = cur.parentNode) {
    if (cur.nodeType !== 1) continue;
    for (const entry of _instanceRoots) {
      if (entry.root === cur) return entry.instance;
    }
  }
  return null;
}

/** Register a DOM root as belonging to an AICapsuleInstance for paste routing. */
export function registerInstanceRoot(root: HTMLElement, instance: AICapsuleInstance): void {
  if (!_instanceRoots.some(e => e.root === root)) {
    _instanceRoots.push({ root, instance });
  }
}

/** Remove a previously-registered DOM root. Idempotent. */
export function unregisterInstanceRoot(root: HTMLElement): void {
  const idx = _instanceRoots.findIndex(e => e.root === root);
  if (idx >= 0) _instanceRoots.splice(idx, 1);
}

const ALLOWED_MIMES = new Set<string>(ALLOWED_IMAGE_MIMES);

/** Chunked base64 — a whole multi-megabyte image would blow the call stack. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** A candidate image, before it is accepted onto the pending queue. */
interface ImageCandidate {
  mediaType: string;
  /** Base64, no data-URI prefix. */
  data: string;
  /** Decoded byte length. */
  rawBytes: number;
  label?: string;
  /** Pixel dimensions, when the producer already knows them. */
  width?: number;
  height?: number;
}

function reportRejected(message: string): false {
  showToast({ title: 'Image not attached', body: message });
  return false;
}

/**
 * Attach a Blob, enforcing the shared image budget.
 *
 * Every entry point — the document paste event, the native clipboard
 * bridge, drag/drop on the AI bar, drag/drop on the side panel, and the
 * image file picker — funnels through here so they cannot drift apart.
 * Previously the clipboard bridge checked nothing at all and pushed
 * whatever the system pasteboard held straight onto the queue, so a Retina
 * screenshot sailed past the 5 MB guard and blew the bridge's 16 MB
 * request-body limit with an error that never mentioned images.
 */
export async function attachBlobToInstance(
  instance: AICapsuleInstance,
  blob: Blob,
  label?: string,
): Promise<boolean> {
  if (!ALLOWED_MIMES.has(blob.type)) {
    return reportRejected('Unsupported image format — PNG, JPEG, WebP or GIF only.');
  }
  const buf = await blob.arrayBuffer();
  return admitImage(instance, {
    mediaType: blob.type,
    data: encodeBase64(new Uint8Array(buf)),
    rawBytes: buf.byteLength,
    label,
  });
}

/**
 * Admit or shrink a candidate. A size rejection is not final: the image is
 * re-encoded at progressively smaller sizes first, because attaching a Retina
 * screenshot is a normal thing to do and refusing it outright would be
 * unhelpful when it can simply be made smaller.
 */
async function admitImage(
  instance: AICapsuleInstance,
  cand: ImageCandidate,
): Promise<boolean> {
  const queuedEncodedBytes = sumEncodedBytes(instance.pendingImages);
  const verdict = evaluateAdmission({
    queuedCount: instance.pendingImages.length,
    queuedEncodedBytes,
    mediaType: cand.mediaType,
    rawBytes: cand.rawBytes,
    encodedBytes: cand.data.length,
  });

  if (verdict.admitted) {
    pushCandidate(instance, cand);
    return true;
  }

  if (verdict.canShrink) {
    const shrunk = await shrinkToFit(instance, cand, queuedEncodedBytes);
    if (shrunk) {
      pushCandidate(instance, shrunk);
      return true;
    }
    return reportRejected(
      `Still too large at ${MIN_LONGEST_EDGE}px — resize it further, or attach fewer images.`,
    );
  }

  return reportRejected(verdict.message);
}

function pushCandidate(instance: AICapsuleInstance, cand: ImageCandidate): void {
  addPendingImage(instance, {
    mediaType: cand.mediaType as AttachedImage['mediaType'],
    data: cand.data,
    label: cand.label,
  });
}

async function shrinkToFit(
  instance: AICapsuleInstance,
  cand: ImageCandidate,
  otherEncodedBytes: number,
): Promise<ImageCandidate | null> {
  const source = await loadCandidateImage(cand);
  if (!source) return null;
  const width = cand.width || source.naturalWidth;
  const height = cand.height || source.naturalHeight;
  if (!width || !height) return null;

  const plan = planShrink({
    longestEdge: Math.max(width, height),
    otherEncodedBytes,
  });

  for (const edge of plan.edges) {
    const out = reencode(source, cand, width, height, edge);
    if (!out) continue;
    const verdict = evaluateAdmission({
      queuedCount: instance.pendingImages.length,
      queuedEncodedBytes: otherEncodedBytes,
      mediaType: out.mediaType,
      rawBytes: out.rawBytes,
      encodedBytes: out.data.length,
    });
    if (verdict.admitted) return out;
  }
  return null;
}

function loadCandidateImage(cand: ImageCandidate): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `data:${cand.mediaType};base64,${cand.data}`;
  });
}

/**
 * Redraw the image at `longestEdge`. PNG stays PNG: it is lossless, and a
 * screenshot is precisely the case where terminal text has to stay legible.
 * JPEG and WebP keep their own format at high quality.
 */
function reencode(
  source: HTMLImageElement,
  cand: ImageCandidate,
  width: number,
  height: number,
  longestEdge: number,
): ImageCandidate | null {
  const scale = longestEdge / Math.max(width, height);
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, outW, outH);

  let mime: string;
  let quality: number | undefined;
  if (cand.mediaType === 'image/png') {
    mime = 'image/png';
    quality = undefined;
  } else if (cand.mediaType === 'image/webp') {
    mime = 'image/webp';
    quality = 0.9;
  } else {
    mime = 'image/jpeg';
    quality = 0.9;
  }

  let url: string;
  try {
    url = quality === undefined ? canvas.toDataURL(mime) : canvas.toDataURL(mime, quality);
  } catch {
    return null;
  }
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const data = url.slice(comma + 1);
  if (!data) return null;
  return {
    mediaType: mime,
    data,
    rawBytes: base64DecodedBytes(data),
    label: cand.label,
  };
}

/** Append an image to the instance's pending list, respecting MAX_IMAGES. */
export function addPendingImage(
  instance: AICapsuleInstance,
  img: AttachedImage,
): void {
  if (instance.pendingImages.length >= MAX_IMAGES) return;
  instance.pendingImages.push(img);
  renderPendingStrip(instance);
}

/** Remove a pending image by its index. */
export function removePendingImage(
  instance: AICapsuleInstance,
  index: number,
): void {
  instance.pendingImages.splice(index, 1);
  renderPendingStrip(instance);
}

/** Clear all pending images (called on send or chat reset). */
export function clearPendingImages(instance: AICapsuleInstance): void {
  instance.pendingImages = [];
  renderPendingStrip(instance);
}

/**
 * Decide where the pending-image strip should live for the current
 * UI mode, and what form it should take. There are two distinct
 * "input surfaces":
 *
 *   • The AI Bar (always visible above the terminal). It is narrow
 *     and shared with command-history / model picker / send buttons,
 *     so a wide thumbnail strip would push everything around. We
 *     render compact "image1 / image2 …" chips here instead.
 *
 *   • The side panel input area (only present in side mode + chat
 *     open). It is wider and dedicated to the agent, so we render
 *     real visual thumbnails.
 *
 * In side mode the AI Bar drops its agent buttons (`ai-bar--side-active`),
 * so attaching pending images to the AI Bar there would be confusing —
 * we always render to the side input area when it's available.
 */
function pickStripContainer(instance: AICapsuleInstance): {
  container: HTMLElement;
  mode: 'compact' | 'thumbnail';
} {
  const sideActive = instance.layoutMode === 'side'
    && !!instance.sideInputArea
    && !!instance.sideInputArea.parentElement;
  if (sideActive) {
    return { container: instance.sideInputArea!, mode: 'thumbnail' };
  }
  return { container: instance.element, mode: 'compact' };
}

/** Remove every pending strip we've ever attached to the instance. */
function removeAllStrips(instance: AICapsuleInstance): void {
  const surfaces: Array<HTMLElement | null> = [
    instance.element,
    instance.sideInputArea,
  ];
  for (const s of surfaces) {
    if (!s) continue;
    s.querySelectorAll('.ai-pending-images').forEach(el => el.remove());
  }
}

/**
 * Re-render the dismissible pending-image strip in whichever
 * container the current layout demands. Old strips on other
 * containers are torn down so we never get duplicate / stale
 * thumbnails on switch.
 */
export function renderPendingStrip(instance: AICapsuleInstance): void {
  // Always start from a clean slate so layout switches don't leave
  // a strip behind on the other surface.
  removeAllStrips(instance);
  if (instance.pendingImages.length === 0) return;

  const { container, mode } = pickStripContainer(instance);

  const strip = document.createElement('div');
  strip.className = `ai-pending-images ai-pending-images--${mode}`;
  // Insert as the first child so it sits above the input row.
  container.insertBefore(strip, container.firstChild);

  if (mode === 'compact') {
    renderCompactChips(strip, instance);
    return;
  }
  renderThumbnailStrip(strip, instance);
}

/**
 * Compact mode (AI Bar): render each pending image as an
 * "image1 ×" chip. No thumbnail — saves horizontal space.
 * Click chip → lightbox preview. Click × → remove.
 */
function renderCompactChips(strip: HTMLDivElement, instance: AICapsuleInstance): void {
  instance.pendingImages.forEach((img, idx) => {
    const chip = document.createElement('div');
    chip.className = 'ai-pending-image-chip';
    chip.title = img.label ?? `image ${idx + 1}`;

    const label = document.createElement('span');
    label.className = 'ai-pending-image-chip-label';
    label.textContent = `image${idx + 1}`;
    label.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openImageLightbox(`data:${img.mediaType};base64,${img.data}`, label.textContent || '');
    });
    chip.appendChild(label);

    const close = document.createElement('button');
    close.className = 'ai-pending-image-chip-remove';
    close.type = 'button';
    close.innerHTML = '&times;';
    close.title = 'Remove image';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      removePendingImage(instance, idx);
    });
    chip.appendChild(close);

    strip.appendChild(chip);
  });
}

/**
 * Thumbnail mode (side panel): render each pending image as a
 * proper visual thumbnail (~64×48). Wide enough that the user
 * can see what they queued up before sending.
 */
function renderThumbnailStrip(strip: HTMLDivElement, instance: AICapsuleInstance): void {
  instance.pendingImages.forEach((img, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'ai-pending-image-thumb';
    thumb.title = img.label ?? `image ${idx + 1}`;

    const el = document.createElement('img');
    el.src = `data:${img.mediaType};base64,${img.data}`;
    el.alt = thumb.title;
    el.draggable = false;
    // Click thumbnail → open in lightbox.
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openImageLightbox(el.src, el.alt);
    });
    thumb.appendChild(el);

    const close = document.createElement('button');
    close.className = 'ai-pending-image-remove';
    close.type = 'button';
    close.innerHTML = '&times;';
    close.title = 'Remove image';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      removePendingImage(instance, idx);
    });
    thumb.appendChild(close);

    strip.appendChild(thumb);
  });
}

/**
 * Wire paste + drag/drop handlers onto the given AI bar element so
 * the user can attach images via clipboard or drag.
 *
 * Paste is handled via a single document-level capture-phase listener
 * (registered lazily on first call) which routes the event to the
 * correct instance via the registry. Drag/drop is per-element on the
 * AI bar div because dragover/drop fire on any DOM element.
 *
 * The "Attach Image" toolbar button is also wired here. Left click
 * opens a file picker; right click reads the system clipboard image
 * directly via the Rust fallback (works around WKWebView's missing
 * paste-event support for screenshots).
 */
export function wireImageAttachmentHandlers(
  instance: AICapsuleInstance,
): void {
  const bar = instance.element;

  // Register the AI bar as paste-eligible. Side panel input area is
  // also registered when it gets created (see registerSidePanelForPaste).
  registerInstanceRoot(bar, instance);
  wireGlobalPasteOnce();

  // ── Attach button: left = universal file picker, right = clipboard paste ──
  const attachBtn = bar.querySelector('.ai-bar-btn-attach') as HTMLButtonElement | null;
  if (attachBtn) {
    attachBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Try clipboard first — if there's an image already in the
      // pasteboard the user is probably trying to paste it. If not,
      // fall through to a universal file picker that accepts images
      // (→ multimodal content) AND any other file (→ saved to the
      // attachments dir and surfaced to the agent by path).
      const fromClipboard = await triggerClipboardImagePaste(instance);
      if (fromClipboard) return;
      await pickAttachmentFilesImpl(instance);
    });
    attachBtn.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await triggerClipboardImagePaste(instance);
    });
  }

  // ── Drag-and-drop handler on the whole AI bar ──
  bar.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    bar.classList.add('ai-bar--drop-hover');
  });
  bar.addEventListener('dragleave', (e) => {
    if ((e.target as HTMLElement) === bar) {
      bar.classList.remove('ai-bar--drop-hover');
    }
  });
  bar.addEventListener('drop', (e) => {
    bar.classList.remove('ai-bar--drop-hover');
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    for (const f of Array.from(e.dataTransfer.files)) {
      // Images ride the multimodal content path…
      if (isImageFile(f)) {
        void attachBlobToInstance(instance, f, f.name);
        continue;
      }
      // …everything else goes through the generic file-attachment path
      // (saved to app-data/attachments, surfaced to the agent as a path).
      void attachFileToInstance(instance, f);
    }
  });
}

/**
 * Register the side-panel input area as paste-eligible for the given
 * instance. Called from ai-capsule-layout.ts when the side panel is
 * created (lazy — only happens after the user switches to side mode).
 */
export function registerSidePanelForPaste(
  instance: AICapsuleInstance,
  inputArea: HTMLElement,
): void {
  registerInstanceRoot(inputArea, instance);
  wireGlobalPasteOnce();

  // Also wire drop on the side panel for parity with the AI bar.
  inputArea.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    inputArea.classList.add('ai-bar--drop-hover');
  });
  inputArea.addEventListener('dragleave', (e) => {
    if ((e.target as HTMLElement) === inputArea) {
      inputArea.classList.remove('ai-bar--drop-hover');
    }
  });
  inputArea.addEventListener('drop', (e) => {
    inputArea.classList.remove('ai-bar--drop-hover');
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    for (const f of Array.from(e.dataTransfer.files)) {
      if (isImageFile(f)) {
        void attachBlobToInstance(instance, f, f.name);
      } else {
        void attachFileToInstance(instance, f);
      }
    }
  });
}

/**
 * Re-export the generic attachment picker so the AI bar "attach" button
 * can offer a "pick any file" fallback when the clipboard/paste path
 * turns up nothing and the user doesn't have an image to drop.
 */
export async function pickAnyAttachmentFiles(instance: AICapsuleInstance): Promise<number> {
  return pickAttachmentFilesImpl(instance);
}
