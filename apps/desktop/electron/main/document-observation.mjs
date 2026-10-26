import { createHash } from 'node:crypto';
import path from 'node:path';

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const validVersion = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

/** Identity follows the resolver's physical scope, never a renderer-supplied root or remote name. */
export function documentIdentity(reference, resolved) {
  const sourceId = hash(JSON.stringify(['peer-document-source-v1', reference.workspaceId, resolved.root,
    reference.task?.sessionId ?? null, reference.task?.planId ?? null]));
  const relativePath = path.relative(resolved.root, resolved.target).split(path.sep).join('/');
  return { sourceId, relativePath, resourceId: hash(JSON.stringify(['peer-document-v1', sourceId, relativePath])) };
}

export function validExpectedObservation(value) {
  return value === undefined || value !== null && typeof value === 'object' && validVersion(value.resourceId)
    && (value.contentVersion === undefined || validVersion(value.contentVersion));
}

/** Reject new bytes before they can become a text/image IPC payload. Re-resolution remains mandatory. */
export function observeDocumentRead(reference, resolved, buffer) {
  const identity = documentIdentity(reference, resolved);
  const observation = { ...identity, contentVersion: hash(buffer) };
  const expected = reference.expectedObservation;
  const status = !validExpectedObservation(expected) ? 'invalid_path'
    : expected && expected.resourceId !== observation.resourceId ? 'source_changed'
      : expected?.contentVersion && expected.contentVersion !== observation.contentVersion ? 'version_changed' : 'ok';
  return { ok: status === 'ok', status, identity, observation };
}
