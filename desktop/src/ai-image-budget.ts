/**
 * ai-image-budget.ts — Payload budgeting for images attached to an AI turn.
 *
 * Why this exists: the Rust bridge (`fetch_ai_stream`) rejects any request
 * body above MAX_REQUEST_BODY_BYTES with a bare "AI request body is too
 * large" — which gives the user no clue that the attached images caused it.
 * Base64 inflates raw bytes by 4/3, so the previous frontend allowance
 * (MAX_IMAGES x 5 MB of *raw* bytes) worked out to roughly 26.7 MB once
 * encoded: a request that could never be sent, and whose rejection nobody
 * could attribute. Both limits are therefore expressed here in ENCODED
 * bytes, and this module is the single source of truth shared by the attach
 * path and its tests.
 *
 * Pure arithmetic only — no DOM, no Tauri — so it can be unit tested under
 * plain `node --test`.
 */

/**
 * Mirror of `MAX_REQUEST_BODY_BYTES` in src-tauri/src/commands/ai.rs.
 * A test asserts the two stay equal.
 */
export const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Head-room kept for the system prompt, tool schemas and the JSON envelope.
 * Tool definitions alone run to tens of KB on every request, so a payload
 * that consumed the whole body limit for images would still be rejected.
 */
export const REQUEST_HEADROOM_BYTES = 1024 * 1024;

/** Encoded-byte ceiling shared by every image in one request. */
export const IMAGE_BUDGET_BYTES = MAX_REQUEST_BODY_BYTES - REQUEST_HEADROOM_BYTES;

/** Raw-byte ceiling for a single image, measured before encoding. */
export const MAX_IMAGE_RAW_BYTES = 5 * 1024 * 1024;

/** Most images one turn may carry. */
export const MAX_IMAGES = 4;

/** Formats the providers accept. */
export const ALLOWED_IMAGE_MIMES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/**
 * Below this longest edge an attached screenshot stops being useful — in
 * particular terminal text turns to mush, which defeats the point of
 * attaching it at all. Used as the floor of the downscale ladder.
 */
export const MIN_LONGEST_EDGE = 1024;

/** Downscale candidates, tried in order until the payload fits. */
export const DOWNSCALE_FACTORS: readonly number[] = [0.75, 0.6, 0.5, 0.4, 0.33];

/** Encoded size of `rawBytes` bytes once base64'd (standard alphabet, padded). */
export function base64Bytes(rawBytes: number): number {
  if (!Number.isFinite(rawBytes) || rawBytes <= 0) return 0;
  return Math.ceil(rawBytes / 3) * 4;
}

/**
 * Decoded size of a base64 string, without building the bytes. Providers
 * hand us already-encoded data (e.g. the clipboard bridge), so we need to
 * know how many raw bytes sit behind it.
 */
export function base64DecodedBytes(data: string): number {
  if (data.length === 0) return 0;
  let padding = 0;
  if (data.endsWith('==')) padding = 2;
  else if (data.endsWith('=')) padding = 1;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** Total encoded bytes carried by a queue of images. */
export function sumEncodedBytes(images: readonly { data: string }[]): number {
  let total = 0;
  for (const img of images) total += img.data.length;
  return total;
}

/**
 * Whether re-encoding this format is safe. GIF is excluded on purpose:
 * rasterising it through a canvas silently drops the animation, which is
 * usually the only reason to attach one.
 */
export function isShrinkable(mediaType: string): boolean {
  return mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp';
}

export type AdmissionReason =
  | 'too-many'
  | 'unsupported-type'
  | 'image-too-large'
  | 'turn-too-large';

export interface AdmissionRequest {
  /** Images already queued for this turn. */
  queuedCount: number;
  /** Encoded bytes those queued images already occupy. */
  queuedEncodedBytes: number;
  /** Candidate's MIME type. */
  mediaType: string;
  /** Candidate's raw (decoded) byte length. */
  rawBytes: number;
  /** Candidate's encoded byte length. */
  encodedBytes: number;
}

export type AdmissionVerdict =
  | { admitted: true }
  | {
      admitted: false;
      reason: AdmissionReason;
      /** User-facing explanation. */
      message: string;
      /** True when re-encoding at a smaller size could still make it fit. */
      canShrink: boolean;
    };

/** Human-readable byte count for user-facing messages. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 10) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

/**
 * Decide whether a candidate image may join this turn's queue as-is.
 *
 * A rejection with `canShrink: true` is not final — the caller should run
 * the downscale ladder and re-submit. `canShrink: false` is terminal.
 */
export function evaluateAdmission(req: AdmissionRequest): AdmissionVerdict {
  if (req.queuedCount >= MAX_IMAGES) {
    return {
      admitted: false,
      reason: 'too-many',
      message: `Up to ${MAX_IMAGES} images per message.`,
      canShrink: false,
    };
  }

  if (!ALLOWED_IMAGE_MIMES.includes(req.mediaType)) {
    return {
      admitted: false,
      reason: 'unsupported-type',
      message: 'Unsupported image format — PNG, JPEG, WebP or GIF only.',
      canShrink: false,
    };
  }

  const shrinkable = isShrinkable(req.mediaType);

  if (req.rawBytes > MAX_IMAGE_RAW_BYTES) {
    return {
      admitted: false,
      reason: 'image-too-large',
      message: `${formatBytes(req.rawBytes)} image — the limit is ${formatBytes(
        MAX_IMAGE_RAW_BYTES,
      )} per image.`,
      canShrink: shrinkable,
    };
  }

  const projected = req.queuedEncodedBytes + req.encodedBytes;
  if (projected > IMAGE_BUDGET_BYTES) {
    return {
      admitted: false,
      reason: 'turn-too-large',
      message: `These images total ${formatBytes(
        projected,
      )} — the request limit is ${formatBytes(IMAGE_BUDGET_BYTES)}.`,
      canShrink: shrinkable,
    };
  }

  return { admitted: true };
}

/**
 * Longest edges to try when shrinking an image, largest first. Empty when
 * the image is already at or below MIN_LONGEST_EDGE, or would not actually
 * get smaller — in both cases there is nothing worth attempting.
 */
export function downscaleLadder(longestEdge: number): number[] {
  if (!Number.isFinite(longestEdge) || longestEdge <= MIN_LONGEST_EDGE) return [];

  const out: number[] = [];
  for (const factor of DOWNSCALE_FACTORS) {
    const target = Math.round(longestEdge * factor);
    if (target >= MIN_LONGEST_EDGE) out.push(target);
  }
  // Always offer the floor as a last resort before giving up.
  if (out.length === 0 || out[out.length - 1] !== MIN_LONGEST_EDGE) {
    out.push(MIN_LONGEST_EDGE);
  }
  return [...new Set(out)].filter((edge) => edge < longestEdge);
}

export interface ShrinkPlan {
  /** Longest edges to try, in order. */
  edges: number[];
  /** Encoded bytes each attempt must come in under to be acceptable. */
  targetEncodedBytes: number;
}

/**
 * Work out how far an image must shrink. `otherEncodedBytes` is what the
 * rest of the turn already occupies (the other queued images); the single
 * image being shrunk has to fit whatever is left of the request budget.
 */
export function planShrink(input: {
  longestEdge: number;
  otherEncodedBytes: number;
}): ShrinkPlan {
  return {
    edges: downscaleLadder(input.longestEdge),
    targetEncodedBytes: Math.max(0, IMAGE_BUDGET_BYTES - input.otherEncodedBytes),
  };
}
