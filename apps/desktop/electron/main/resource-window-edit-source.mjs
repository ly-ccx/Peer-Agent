import path from 'node:path';
const failure = code => ({ ok: false, code });
const inside = (root, target) => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
/** Native draft sources remain inside the existing read-only lease; this grants no file write. */
export function createResourceWindowEditSource({ registry, reader, getScope }) {
  function locate(sender, source) {
    const found = registry.readBinding(sender, source?.identity); if (!found.ok) return null;
    const context = found.context, scope = getScope(context.viewId), resource = context.resource;
    if (!scope || resource.kind === 'comparison' || resource.reference.revision || resource.kind === 'document' && resource.mode === 'diff') return null;
    const target = source.path ?? (resource.kind === 'document' ? scope.target : null);
    if (!target || !path.isAbsolute(target) || (resource.kind === 'directory' ? !inside(scope.target, target) : target !== scope.target)) return null;
    return { context, scope, target };
  }
  return {
    isCurrent(sender, source) { return !!locate(sender, source); },
    /** Host-only current source proof. It neither grants write permission nor expands a read lease. */
    async resolveSubmissionTarget(sender, source, target) {
      const captured = locate(sender, source);
      if (!captured || target.reference.path !== captured.target || target.base.resourceId !== source.observed.resourceId) return failure('RESOURCE_EDIT_SOURCE_CHANGED');
      const result = await reader.read(captured.scope, { identity: source.identity, operation: 'content', path: captured.target,
        expectedObservation: { resourceId: target.base.resourceId }, loadCurrent: true });
      const valid = () => { const latest = locate(sender, source); return !!latest && latest.scope === captured.scope && latest.target === captured.target; };
      if (!valid()) return failure('RESOURCE_EDIT_SOURCE_CHANGED');
      if (!result?.ok) return { ok: false, status: result?.status ?? 'source_unavailable' };
      const document = result.document;
      if (document?.media !== 'text' || document.revision || document.resolvedPath !== captured.target || document.resolvedFrom !== captured.scope.root
        || document.observation?.resourceId !== target.base.resourceId) return failure('RESOURCE_EDIT_SOURCE_CHANGED');
      return { ok: true, root: captured.scope.root, path: captured.target, resourceId: document.observation.resourceId, contentVersion: document.observation.contentVersion, validate: valid };
    },
    async read(sender, source, { signal } = {}) {
      const captured = locate(sender, source); if (!captured || signal?.aborted) return failure('RESOURCE_EDIT_SOURCE_CHANGED');
      const result = await reader.read(captured.scope, { identity: source.identity, operation: 'content', path: captured.target, expectedObservation: source.observed });
      const current = locate(sender, source);
      if (signal?.aborted || !current || current.scope !== captured.scope || current.target !== captured.target) return failure('RESOURCE_EDIT_SOURCE_CHANGED');
      if (!result.ok) return { ok: false, status: result.status };
      const document = result.document;
      if (!document || document.media !== 'text' || document.revision || !document.observation || !document.resolvedPath) return failure('RESOURCE_EDIT_UNSUPPORTED_TEXT');
      return { ok: true, owner: captured.context.owner,
        reference: { ...captured.context.resource.reference, path: document.resolvedPath, relativeTo: undefined, kind: 'file', expectedObservation: source.observed },
        content: document.content, observation: document.observation };
    },
  };
}
