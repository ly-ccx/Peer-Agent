import { interactiveDigest, interactiveToken, normalizeInteractiveFollowup, normalizeInteractiveOwner } from '@peer-agent/protocol';
import { decode, encode, jsonDigest, problem } from './storage.mjs';

export const RETIRED_FOLLOWUP = 'interactive-followup-retired';

export function readFollowupRecord(row, owner, followupId) {
  if (!row || row.owner !== encode(owner)) throw problem('interactive_followup_unavailable');
  if (!interactiveDigest(row.argsDigest)) throw problem('interactive_followup_corrupt');
  const snapshot = decode(row.snapshot);
  if (!snapshot || typeof snapshot !== 'object') throw problem('interactive_followup_corrupt');
  if (snapshot.kind === RETIRED_FOLLOWUP) {
    const { receiptDigest, ...body } = snapshot;
    const recipient = normalizeInteractiveOwner(body.recipient);
    if (Object.keys(body).length !== 8 || body.schemaVersion !== 1 || body.followupId !== followupId
      || !recipient || encode(recipient) !== row.owner || body.argsDigest !== row.argsDigest
      || !interactiveToken(body.requestId) || !interactiveDigest(body.expectedDigest)
      || !Number.isFinite(Date.parse(body.cleanedAt)) || !interactiveDigest(receiptDigest) || jsonDigest(body) !== receiptDigest)
      throw problem('interactive_followup_corrupt');
    return { retired: snapshot };
  }
  const { selectionDigest, ...body } = snapshot;
  if (!normalizeInteractiveFollowup(snapshot) || jsonDigest(body) !== selectionDigest
    || snapshot.followupId !== followupId || encode(snapshot.recipient) !== row.owner) throw problem('interactive_followup_corrupt');
  return { snapshot };
}

export function readAvailableFollowup(row, owner, followupId) {
  const record = readFollowupRecord(row, owner, followupId);
  if (record.retired) throw problem('interactive_followup_cleaned');
  return record.snapshot;
}
