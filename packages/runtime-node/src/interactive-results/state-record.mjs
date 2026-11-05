import { interactiveToken } from '@peer-agent/protocol';
import { validateState } from '@peer-agent/interactive-content/state';
import { encode, jsonDigest, problem } from './storage.mjs';

/** The same checkpoint/receipt invariants apply to ordinary reads and maintenance. */
export function checkedInteractiveSnapshot(snapshot, ref, published) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Object.keys(snapshot).length !== 9
    || Object.keys(snapshot).some(key => !['result', 'specHash', 'stateSchemaHash', 'stateRevision', 'values', 'inputDrafts', 'stateDigest', 'updatedAt', 'requestId'].includes(key))
    || !interactiveToken(snapshot.requestId) || !Number.isFinite(Date.parse(snapshot.updatedAt))
    || encode(snapshot.result) !== encode(ref) || snapshot.specHash !== published.content.specHash || snapshot.stateSchemaHash !== published.content.stateSchemaHash
    || !Number.isSafeInteger(snapshot.stateRevision) || snapshot.stateRevision < 0
    || jsonDigest({ values: snapshot.values, inputDrafts: snapshot.inputDrafts }) !== snapshot.stateDigest) throw problem('interactive_state_corrupt');
  validateState(snapshot.values, published.content.stateSchema, snapshot.inputDrafts);
  return snapshot;
}
