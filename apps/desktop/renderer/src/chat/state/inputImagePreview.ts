import { clientApi } from '../../clientApi';
import type { ChatAttachment } from './types';

export interface InputImageReference {
  readonly workspaceId: string;
  readonly blobDigest: string;
  readonly mimeType: string;
}

export function inputImageReference(attachment: ChatAttachment, workspaceId?: string): InputImageReference | undefined {
  if (workspaceId && attachment.kind === 'image' && attachment.blobDigest) {
    return { workspaceId, blobDigest: attachment.blobDigest, mimeType: attachment.mimeType };
  }
}

const inflight = new Map<string, Promise<string | null>>();

/** Share simultaneous thumbnail/lightbox reads, without retaining full images after use. */
export function loadInputImageDataUrl(ref: InputImageReference): Promise<string | null> {
  const key = JSON.stringify([ref.workspaceId, ref.blobDigest, ref.mimeType]);
  const pending = inflight.get(key);
  if (pending) return pending;
  const read = Promise.resolve().then(() => clientApi.projectAgentReadInputImage(ref))
    .then(result => result?.ok && result.dataUrl.startsWith('data:image/') ? result.dataUrl : null)
    .catch(() => null).finally(() => inflight.delete(key));
  inflight.set(key, read);
  return read;
}
