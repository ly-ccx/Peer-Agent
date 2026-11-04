import { interactiveDigest, interactiveToken } from '@peer-agent/protocol';
import { decode, encode, jsonDigest, problem } from './storage.mjs';

export const RETIRED_MATERIAL = 'interactive-material-retired';
export const materialKey = source => source?.kind === 'tool-result' && interactiveToken(source.conversationId) && interactiveToken(source.toolCallId)
  ? jsonDigest([source.kind, source.conversationId, source.toolCallId])
  : source?.kind === 'user-material' && interactiveToken(source.messageId) && interactiveToken(source.attachmentId)
    ? jsonDigest([source.kind, source.messageId, source.attachmentId, source.expectedContentVersion ?? null]) : null;

export const validMaterialOrigin = (source, origin) => source.kind === 'user-material' && !!origin && Object.keys(origin).length === 3
  && [origin.conversationId, origin.planId, origin.sessionId].every(interactiveToken);

export function readMaterialRecord(row, owner, source) {
  if (!row || row.owner !== encode(owner)) return null;
  const metadata = decode(row.metadata);
  if (!metadata || encode(metadata.owner) !== row.owner) throw problem('interactive_storage_corrupt');
  if (encode(metadata.source) !== encode(source)) throw problem('material_version_mismatch');
  if (metadata.contentVersion !== source.expectedContentVersion || !interactiveDigest(metadata.contentVersion)) throw problem('interactive_storage_corrupt');
  if (row.object !== '') {
    if (row.object !== metadata.contentVersion || metadata.kind === RETIRED_MATERIAL
      || (metadata.origin !== undefined && !validMaterialOrigin(source, metadata.origin))) throw problem('interactive_storage_corrupt');
    return { metadata };
  }
  const { receiptDigest, ...body } = metadata;
  if (Object.keys(body).length !== 8 || body.kind !== RETIRED_MATERIAL || body.schemaVersion !== 1
    || !interactiveToken(body.requestId) || !interactiveDigest(body.expectedDigest) || !Number.isFinite(Date.parse(body.cleanedAt))
    || !interactiveDigest(receiptDigest) || jsonDigest(body) !== receiptDigest) throw problem('interactive_storage_corrupt');
  return { retired: metadata };
}
