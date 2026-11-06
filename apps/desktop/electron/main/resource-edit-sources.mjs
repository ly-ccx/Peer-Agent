import { createHash } from 'node:crypto';
import { normalizeResourceEditTarget, normalizeResourceEditSource, validResourceEditText } from '@peer-agent/protocol';
const failure = code => ({ ok: false, code });
const digest = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
export function resourceEditReadFailure(status) {
  return ({ scope_denied: 'RESOURCE_EDIT_SCOPE_DENIED', permission_denied: 'RESOURCE_EDIT_SCOPE_DENIED', not_found: 'RESOURCE_EDIT_FILE_NOT_FOUND',
    version_changed: 'RESOURCE_EDIT_VERSION_CHANGED', source_changed: 'RESOURCE_EDIT_SOURCE_CHANGED', too_large: 'RESOURCE_EDIT_TEXT_LIMIT', binary: 'RESOURCE_EDIT_UNSUPPORTED_TEXT', not_file: 'RESOURCE_EDIT_UNSUPPORTED_TEXT' })[status] || 'RESOURCE_EDIT_SOURCE_UNAVAILABLE';
}
/** Binds actual Bot + current read observation using existing human reader adapters only. */
export function createResourceEditSources({ fileAccess, resourceWindows, getRole, getOwner }) {
  const live = sender => sender && !sender.isDestroyed?.();
  function current(sender, source) {
    if (!live(sender)) return false;
    return source?.kind === 'document' ? getRole(sender) === 'main'
      : source?.kind === 'native' && getRole(sender) === 'resource' && resourceWindows.isEditingSourceCurrent(sender, source);
  }
  function submissionCurrent(sender, source, target) {
    return live(sender) && getOwner(target.recipient.workspaceId)?.conversationId === target.recipient.conversationId
      && (getRole(sender) === 'main' && (!source || source.kind === 'document') || source?.kind === 'native' && current(sender, source));
  }
  const api = {
    isCurrent: current,
    async resolveSubmissionTarget(sender, source, raw) {
      const target = normalizeResourceEditTarget(raw); if (!target || !submissionCurrent(sender, source, target)) return failure('RESOURCE_EDIT_SOURCE_CHANGED');
      if (source?.kind === 'native') {
        const found = await resourceWindows.resolveEditingTarget(sender, source, target);
        return found?.ok && submissionCurrent(sender, source, target) ? { ...found, validate: () => submissionCurrent(sender, source, target) && found.validate() }
          : failure(found?.ok ? 'RESOURCE_EDIT_SOURCE_CHANGED' : found?.code ?? resourceEditReadFailure(found?.status));
      }
      const metadata = await fileAccess.readFile({ documentReference: { ...target.reference, metadataOnly: true, expectedObservation: { resourceId: target.base.resourceId } } });
      if (!metadata?.ok) return failure(resourceEditReadFailure(metadata?.status));
      if (!submissionCurrent(sender, source, target) || !metadata.metadataOnly || metadata.resolvedPath !== target.reference.path
        || typeof metadata.resolvedFrom !== 'string' || metadata.identity?.resourceId !== target.base.resourceId) return failure('RESOURCE_EDIT_SOURCE_CHANGED');
      return { ok: true, root: metadata.resolvedFrom, path: metadata.resolvedPath, resourceId: metadata.identity.resourceId, validate: () => submissionCurrent(sender, source, target) };
    },
    async readSubmissionCurrent(sender, source, raw) {
      const target = normalizeResourceEditTarget(raw); if (!target) return failure('RESOURCE_EDIT_SOURCE_CHANGED');
      const found = await api.resolveSubmissionTarget(sender, source, target); if (!found.ok) return found;
      if (source?.kind === 'native') return { ok: true, resourceId: found.resourceId, contentVersion: found.contentVersion };
      const read = await fileAccess.readFile({ documentReference: { ...target.reference, expectedObservation: { resourceId: target.base.resourceId } } });
      return read?.ok && found.validate() && read.resolvedPath === found.path && read.resolvedFrom === found.root && read.observation?.resourceId === found.resourceId
        ? { ok: true, resourceId: read.observation.resourceId, contentVersion: read.observation.contentVersion } : failure(resourceEditReadFailure(read?.status));
    },
    async read(sender, raw, { signal } = {}) {
      const source = normalizeResourceEditSource(raw); if (!source || !current(sender, source) || signal?.aborted) return failure('RESOURCE_EDIT_SOURCE_CHANGED');
      let read;
      if (source.kind === 'native') read = await resourceWindows.readEditingSource(sender, source, { signal });
      else {
        const owner = getOwner(source.reference.workspaceId); if (!owner?.conversationId) return failure('RESOURCE_EDIT_SOURCE_UNAVAILABLE');
        const result = await fileAccess.readFile({ documentReference: source.reference });
        read = result?.ok ? { ok: true, owner: { workspaceId: source.reference.workspaceId, conversationId: owner.conversationId },
          reference: { ...source.reference, path: result.resolvedPath, relativeTo: undefined }, content: result.content, observation: result.observation } : result;
      }
      if (!read?.ok) return failure(read?.code || resourceEditReadFailure(read?.status));
      if (signal?.aborted || !current(sender, source)) return failure('RESOURCE_EDIT_SOURCE_CHANGED');
      const owner = getOwner(read.owner?.workspaceId);
      if (!owner?.conversationId || owner.conversationId !== read.owner?.conversationId) return failure('RESOURCE_EDIT_RECIPIENT_CHANGED');
      const observed = read.observation;
      if (!observed || observed.resourceId !== source.observed.resourceId || observed.contentVersion !== source.observed.contentVersion) return failure('RESOURCE_EDIT_VERSION_CHANGED');
      if (!validResourceEditText(read.content) || digest(read.content) !== observed.contentVersion) return failure('RESOURCE_EDIT_UNSUPPORTED_TEXT');
      const target = normalizeResourceEditTarget({ recipient: { workspaceId: read.owner.workspaceId, conversationId: read.owner.conversationId }, reference: read.reference,
        base: { resourceId: observed.resourceId, contentVersion: observed.contentVersion } });
      return target ? { ok: true, target, content: read.content } : failure('RESOURCE_EDIT_SOURCE_CHANGED');
    },
    async canReadRetained(sender, target, source) {
      if (!live(sender)) return false;
      const owner = getOwner(target.recipient.workspaceId); if (owner?.conversationId !== target.recipient.conversationId) return false;
      if (getRole(sender) !== 'main' && !(source?.kind === 'native' && current(sender, source) && source.observed.resourceId === target.base.resourceId)) return false;
      const metadata = await fileAccess.readFile({ documentReference: { ...target.reference, metadataOnly: true } });
      return !!metadata?.ok && metadata.metadataOnly === true && metadata.identity?.resourceId === target.base.resourceId
        && live(sender) && getOwner(target.recipient.workspaceId)?.conversationId === target.recipient.conversationId
        && (getRole(sender) === 'main' || current(sender, source));
    },
  };
  return api;
}
