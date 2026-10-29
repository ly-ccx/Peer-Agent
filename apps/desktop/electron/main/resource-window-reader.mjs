import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const fail = status => ({ ok: false, status });
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const observation = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => ['resourceId', 'contentVersion'].includes(key))
  && /^sha256:[a-f0-9]{64}$/.test(value.resourceId)
  && (value.contentVersion === undefined || /^sha256:[a-f0-9]{64}$/.test(value.contentVersion));

/** A narrower adapter over the existing scoped reader, never another filesystem authority. */
export function createResourceWindowReader({ resolveDocument, fileAccess, getOwner }) {
  async function resolve(resource, captured) {
    const owner = await getOwner(resource.reference.workspaceId);
    if (!owner?.conversationId || captured && owner.conversationId !== captured.owner.conversationId) return fail('source_unavailable');
    const found = await resolveDocument(resource.reference);
    if (!found?.ok) return fail(found?.status ?? 'source_unavailable');
    if (typeof found.root !== 'string' || typeof found.target !== 'string' || !path.isAbsolute(found.root) || !path.isAbsolute(found.target)) return fail('source_unavailable');
    if (captured && found.root !== captured.root) return fail('source_changed');
    if (!inside(found.root, found.target)) return fail('scope_denied');
    return { ok: true, root: found.root, target: found.target, owner: { workspaceId: resource.reference.workspaceId,
      conversationId: owner.conversationId, ...(resource.reference.task ? { task: resource.reference.task } : {}) } };
  }
  return {
    async prepare(resource) {
      if (resource.kind === 'comparison' && !resource.comparison && (!sha(resource.fromRef) || resource.toRef !== undefined && !sha(resource.toRef))) return fail('invalid_ref');
      const found = await resolve(resource);
      if (!found.ok) return found;
      const canonical = { ...resource, reference: { ...resource.reference, path: found.target } };
      // Metadata checks the real file/directory type; no body is copied during window creation.
      const metadata = await fileAccess.readFile({ documentReference: { ...canonical.reference, metadataOnly: true } });
      if (!metadata?.ok || !metadata.metadataOnly) return fail(metadata?.status ?? 'source_unavailable');
      if (metadata.resolvedPath !== found.target || metadata.resolvedFrom !== found.root) return fail('source_changed');
      return { ...found, resource: canonical };
    },
    async read(captured, request) {
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some(key => !['identity', 'operation', 'path', 'expectedObservation', 'loadCurrent'].includes(key))
        || !['content', 'directory', 'diff'].includes(request.operation)
        || request.loadCurrent !== undefined && typeof request.loadCurrent !== 'boolean'
        || request.expectedObservation !== undefined && !observation(request.expectedObservation)) return fail('invalid_request');
      const resource = captured.resource;
      const isDirectory = resource.kind === 'directory';
      if (request.path !== undefined && (typeof request.path !== 'string' || request.path.length > 8192 || /[\u0000-\u001f]/.test(request.path)
        || !path.isAbsolute(request.path) || !isDirectory && request.path !== resource.reference.path)) return fail('scope_denied');
      if (request.operation === 'directory' && !isDirectory || request.operation === 'content' && (resource.kind === 'comparison' || resource.kind === 'document' && resource.mode === 'diff')
        || request.operation === 'diff' && resource.kind !== 'comparison' && !(resource.kind === 'document' && resource.mode === 'diff')) return fail('scope_denied');
      const target = request.path ?? resource.reference.path;
      const reference = { ...resource.reference, path: target, kind: request.operation === 'directory' || resource.kind === 'comparison' ? 'directory' : 'file' };
      const found = await resolve({ ...resource, reference }, captured);
      if (!found.ok) return found;
      if (isDirectory ? !inside(captured.target, found.target) : found.target !== captured.target) return fail('scope_denied');
      if (request.operation === 'directory') {
        const result = await fileAccess.readDirectory({ documentReference: reference });
        if (result?.ok && (result.resolvedFrom !== captured.root || result.resolvedPath !== found.target)) return fail('source_changed');
        return result?.ok ? { ok: true, status: 'ok', directory: { entries: result.entries, truncated: result.truncated } } : fail(result?.status ?? 'source_unavailable');
      }
      if (request.operation === 'diff') {
        const result = resource.kind === 'comparison'
          ? await fileAccess.getGitRangeDiff({ workspaceRoot: found.target, documentReference: reference, fromRef: resource.fromRef,
            ...(resource.toRef ? { toRef: resource.toRef } : {}), ...(resource.comparison ? { comparison: resource.comparison } : {}) })
          : await fileAccess.getGitDiff({ documentReference: reference, comparison: resource.comparison });
        if (result?.ok && result.resolvedPath !== found.target) return fail('source_changed');
        if (result?.ok && resource.kind === 'comparison' && !resource.comparison
          && (result.fromRef?.toLowerCase() !== resource.fromRef.toLowerCase() || resource.toRef && result.toRef?.toLowerCase() !== resource.toRef.toLowerCase())) return fail('source_changed');
        return result?.ok ? { ok: true, status: 'ok', diff: { diffText: result.diffText, ...(result.fromRef ? { fromRef: result.fromRef } : {}), ...(result.toRef ? { toRef: result.toRef } : {}),
          ...(result.untracked ? { untracked: result.untracked, untrackedTruncated: result.untrackedTruncated === true } : {}) } } : fail(result?.status ?? 'source_unavailable');
      }
      const initial = reference.expectedObservation;
      const expected = request.expectedObservation ?? initial;
      if (initial && expected?.resourceId !== initial.resourceId) return fail('source_changed');
      const condition = expected && (request.loadCurrent ? { resourceId: expected.resourceId } : expected);
      const metadata = await fileAccess.readFile({ documentReference: { ...reference, metadataOnly: true } });
      if (!metadata?.ok) return fail(metadata?.status ?? 'source_unavailable');
      if (metadata.resolvedPath !== found.target || metadata.resolvedFrom !== found.root) return fail('source_changed');
      const exact = { ...reference, ...(condition ? { expectedObservation: condition } : metadata.identity ? { expectedObservation: { resourceId: metadata.identity.resourceId } } : {}) };
      const image = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(found.target);
      const result = await (image ? fileAccess.readImageDataUrl : fileAccess.readFile)({ documentReference: exact });
      if (result?.ok && (result.resolvedPath !== found.target || result.resolvedFrom !== captured.root)) return fail('source_changed');
      if (result?.ok && reference.revision && !isDeepStrictEqual(result.revision, metadata.revision)) return fail('source_changed');
      return result?.ok ? { ok: true, status: 'ok', document: { ...result, content: result.content ?? '', media: image ? 'image' : 'text' } } : fail(result?.status ?? 'source_unavailable');
    },
  };
}
