import path from 'node:path';
import { normalizeResourceFeedback } from '@peer-agent/protocol';
const fail = code => ({ ok: false, code });
const sameTask = (a, b) => (a?.sessionId ?? '') === (b?.sessionId ?? '') && (a?.planId ?? '') === (b?.planId ?? '');
const sameRevision = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const inside = (root, target) => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
/** Human-selected quote admission within an existing read-only lease. This is never a write scope. */
export function createResourceWindowFeedback({ registry, reader, getScope, prepare }) {
  return async (sender, payload) => {
    const found = registry.readBinding(sender, payload?.identity); if (!found.ok) return fail('SOURCE_UNAVAILABLE');
    const feedback = normalizeResourceFeedback(payload?.feedback), context = found.context;
    if (!feedback || feedback.resource.kind === 'web' || feedback.recipient.workspaceId !== context.owner.workspaceId || feedback.recipient.conversationId !== context.owner.conversationId) return fail('INVALID_RESOURCE_FEEDBACK');
    const resource = feedback.resource, original = context.resource;
    if (resource.reference.workspaceId !== context.owner.workspaceId || !sameTask(resource.reference.task, original.reference.task) || !sameRevision(resource.reference.revision, original.reference.revision)) return fail('SOURCE_CHANGED');
    if (original.kind === 'comparison' && (resource.kind !== 'comparison' || resource.fromRef !== original.fromRef || resource.toRef !== original.toRef || resource.comparison !== original.comparison)) return fail('SOURCE_CHANGED');
    if (original.kind === 'document' && (resource.kind !== 'document' || resource.mode === 'diff' && (original.mode !== 'diff' || resource.comparison !== original.comparison) || original.mode === 'diff' && resource.mode !== 'diff')) return fail('SOURCE_CHANGED');
    if (original.kind === 'directory' && (resource.kind === 'comparison' || resource.kind === 'document' && resource.mode === 'diff')) return fail('SOURCE_CHANGED');
    const target = registry.returnTarget(sender, payload.identity); if (!target.ok || !prepare) return fail('SOURCE_UNAVAILABLE');
    const scope = getScope(context.viewId); if (!scope) return fail('SOURCE_UNAVAILABLE');
    const current = async () => {
      if (!registry.readBinding(sender, payload.identity).ok || getScope(context.viewId) !== scope) return false;
      const resolved = await reader.prepare(resource);
      return resolved?.ok && resolved.owner.conversationId === context.owner.conversationId && resolved.root === scope.root
        && (original.kind === 'directory' ? inside(scope.target, resolved.target) : resolved.target === scope.target);
    };
    try {
      if (!await current()) return fail('SOURCE_CHANGED');
      return await prepare({ sourceSender: target.sourceSender, identity: { viewId: context.viewId, windowId: context.windowId, generation: context.generation }, feedback, isCurrent: current });
    } catch { return fail('SOURCE_UNAVAILABLE'); }
  };
}
