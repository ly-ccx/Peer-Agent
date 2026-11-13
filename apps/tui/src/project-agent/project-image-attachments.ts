import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ProjectInputAttachment } from '@peer-agent/protocol';
import { loadLocalImageAttachments } from '../composer-image-paths.ts';

/** Mirrors the durable boundary in runtime-node input-attachments.mjs. */
export const PROJECT_INPUT_ATTACHMENT_LIMIT = 8;
const IMAGE_BYTES = 8 * 1024 * 1024;

/** The protocol's upload shape, restricted to the image variant this module produces. */
export type ProjectImageAttachment = Extract<ProjectInputAttachment, { kind: 'image' }>;

export interface ProjectImageLoad {
  readonly text: string;
  readonly attachments: readonly ProjectImageAttachment[];
  readonly missingPaths: readonly string[];
}

export interface AttachmentDraftLike {
  readonly attachments?: readonly { readonly id: string }[];
}

/** Bytes actually encoded in a base64 data URL; `size` must match or the runtime rejects it. */
export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const payload = dataUrl.slice(comma + 1);
  return Buffer.from(payload, 'base64').byteLength;
}

/**
 * Stable id derived from the image payload, so re-pasting the same file while the
 * draft still holds it replaces the row instead of duplicating it.
 */
function attachmentIdFor(dataUrl: string): string {
  return `image-${createHash('sha256').update(dataUrl).digest('hex').slice(0, 16)}`;
}

/**
 * Reuses the classic composer's image loader, then maps its result onto the
 * project input attachment contract (id/name/size/sourceKind/kind/dataUrl).
 */
export async function loadProjectImageAttachments(
  text: string,
  options?: { readonly pathByKey?: ReadonlyMap<string, string> | Readonly<Record<string, string>> },
): Promise<ProjectImageLoad> {
  const loaded = await loadLocalImageAttachments(text, { maxBytes: IMAGE_BYTES, pathByKey: options?.pathByKey });
  const attachments: ProjectImageAttachment[] = [];
  for (const image of loaded.images) {
    const dataUrl = image.url;
    const mimeType = image.mimeType ?? /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/png';
    // Skip anything the durable boundary would reject rather than failing the whole send.
    if (!dataUrl.startsWith(`data:${mimeType};base64,`)) continue;
    const size = dataUrlByteLength(dataUrl);
    if (!Number.isSafeInteger(size) || size <= 0 || size > IMAGE_BYTES) continue;
    const name = imageNameFor(loaded.text, text) ?? `image-${attachments.length + 1}`;
    attachments.push({
      id: attachmentIdFor(dataUrl), name, mimeType, size,
      sourceKind: 'user_upload', kind: 'image', dataUrl,
    });
    if (attachments.length >= PROJECT_INPUT_ATTACHMENT_LIMIT) break;
  }
  return { text: loaded.text, attachments, missingPaths: loaded.missingPaths };
}

/** Best-effort display name: prefer a basename from the source text, else a positional label. */
function imageNameFor(_remaining: string, sourceText: string): string | null {
  const match = /([^/\s"'`]+\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif))/i.exec(sourceText);
  if (!match?.[1]) return null;
  return path.basename(match[1]);
}

/** Carry over existing draft attachments so a re-paste updates instead of duplicating. */
export function mergeProjectAttachments(
  existing: readonly ProjectImageAttachment[],
  incoming: readonly ProjectImageAttachment[],
): ProjectImageAttachment[] {
  const byId = new Map(existing.map(item => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].slice(-PROJECT_INPUT_ATTACHMENT_LIMIT);
}
