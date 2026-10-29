import path from 'node:path';
import { fileURLToPath } from 'node:url';
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) && !value.includes('..');
const denied = () => ({ deliveryStatus: 'scope_denied', deliveries: [] });
/** Existing Watch evidence has its own immutable, workspace-bound registry; it produces no UserArtifact here. */
export function createScopedExternalEvidenceReader({ findWatch, readWatchBody }) {
  return (ref, context, { metadataOnly = false } = {}) => {
    const record = findWatch(ref);
    if (!record || record.evidenceRef !== ref) return null;
    if (!context || !id(context.workspaceId) || context.task !== undefined || record.workspaceId !== context.workspaceId) {
      return { availability: 'unavailable', ...denied(), code: 'SCOPE_DENIED' };
    }
    if (metadataOnly) return { source: { evidenceRef: ref } };
    const body = readWatchBody(ref);
    return body ? { ...body, availability: 'available', deliveryStatus: 'available', deliveries: [] } : { availability: 'not_found', deliveryStatus: 'unavailable' };
  };
}
const taskMatches = (plan, session, workspaceId, task) => plan?.planId === task.planId
  && plan.delegationOrigin?.workspaceId === workspaceId && plan.delegationOrigin?.sessionId === task.sessionId
  && session?.sessionId === task.sessionId && session.workspaceId === workspaceId && session.report?.planId === task.planId;
function locator(artifact) {
  const declared = typeof artifact.path === 'string' ? artifact.path : '';
  if (declared && declared.length <= 8192 && path.isAbsolute(declared) && !/[\u0000-\u001f]/.test(declared)) return declared;
  try { const target = fileURLToPath(artifact.ref); return target.length <= 8192 && !/[\u0000-\u001f]/.test(target) ? target : null; } catch { return null; }
}
/** Pure projection of canonical index metadata. No filesystem reads, root admission, execution or snapshots. */
export function createEvidenceDeliveryProjection({ getConversationId, getPlan, getSession }) {
  return (record, context) => {
    if (!context || !id(context.workspaceId) || context.task !== undefined && (!id(context.task?.sessionId) || !id(context.task?.planId))) return denied();
    const workspaceId = context.workspaceId; let task;
    if (record.planId) {
      if (!id(record.planId)) return denied();
      const plan = getPlan(record.planId), origin = plan?.delegationOrigin;
      task = { sessionId: origin?.sessionId, planId: record.planId };
      if (!id(task.sessionId) || !id(task.planId) || context.task && (context.task.sessionId !== task.sessionId || context.task.planId !== task.planId)
        || !taskMatches(plan, getSession(task.sessionId), workspaceId, task)) return denied();
    } else if (context.task || !record.conversationId || record.conversationId !== getConversationId(workspaceId)) return denied();
    const deliveries = [], seen = new Set(); let previewBudget = 512 * 1024;
    for (const artifact of Array.isArray(record.userArtifacts) ? record.userArtifacts : []) {
      if (deliveries.length >= 8) break;
      if (!['file', 'code-change', 'image'].includes(artifact?.kind) || typeof artifact.ref !== 'string' || !artifact.ref.trim()
        || artifact.ref.length > 8192 || /[\u0000-\u001f]/.test(artifact.ref) || seen.has(artifact.ref)) continue;
      seen.add(artifact.ref); const target = locator(artifact);
      const fallback = (target ? path.basename(target) : '') || { file: 'File', 'code-change': 'Code change', image: 'Image' }[artifact.kind];
      const rawLabel = typeof artifact.label === 'string' ? artifact.label.replace(/[\u0000-\u001f]/g, '').trim() : '';
      const label = (!rawLabel || /^[\da-f]{8}-[\da-f-]{27,}$/i.test(rawLabel) || /:\/\//.test(rawLabel) ? fallback : rawLabel).slice(0, 160);
      const delivery = { evidenceRef: record.evidenceRef, artifactRef: artifact.ref, kind: artifact.kind, label,
        ...(target ? { reference: { workspaceId, path: target, kind: 'file', ...(task ? { task } : {}) } } : {}) };
      const preview = artifact.preview;
      if (['file', 'code-change'].includes(artifact.kind) && preview?.kind === 'code' && Array.isArray(preview.diffLines)) {
        const text = preview.diffLines.filter(line => typeof line === 'string').slice(0, 41).map(line => line.slice(0, 240)).join('\n');
        if (text && text.length <= previewBudget) { delivery.savedPreview = { kind: 'diff-summary', text, truncated: true }; previewBudget -= text.length; }
      } else if (artifact.kind === 'image' && preview?.kind === 'image' && typeof preview.dataUrl === 'string'
        && preview.dataUrl.length <= Math.min(256 * 1024, previewBudget) && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(preview.dataUrl)
        && Number.isSafeInteger(preview.width) && preview.width > 0 && preview.width <= 640
        && Number.isSafeInteger(preview.height) && preview.height > 0 && preview.height <= 640) {
        delivery.savedPreview = { kind: 'image', dataUrl: preview.dataUrl, width: preview.width, height: preview.height }; previewBudget -= preview.dataUrl.length;
      }
      if (preview && !delivery.savedPreview) delivery.previewUnavailable = true;
      deliveries.push(delivery);
    }
    return { deliveryStatus: 'available', deliveries };
  };
}
