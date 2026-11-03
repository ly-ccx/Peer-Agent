import { createInteractiveAuthority } from './authority.mjs';
import { createInteractiveCapture } from './capture.mjs';
import { createInteractiveMaterialSource } from './material-source.mjs';
import { createInteractiveResultProvider } from './provider.mjs';
import { createInteractiveStateStore } from './state-store.mjs';
import { createInteractiveResultStore } from './store.mjs';
import { normalizeInteractiveOwner } from '@peer-agent/protocol';
import { createInteractiveUserMaterials } from './user-materials.mjs';
import { createInteractiveFeedbackAdmission } from './feedback-admission.mjs';
import { createInteractiveVerification } from './verification.mjs';
import { createInteractivePublicationSource } from './publication-source.mjs';
import { createInteractiveRetention } from './retention.mjs';

/** One shared domain instance per host. Composition roots supply real local facts. */
export function createInteractiveRuntime({ rootDir, goalPlanStore, conversationStore, getBotConversationId,
  holdsLease, enabled, classifyContext, readUserMaterial, readMaterialMetadata, getSession, now, validate, acquireRetentionRoots } = {}) {
  const resultStore = createInteractiveResultStore({ ...(rootDir ? { rootDir } : {}), ...(now ? { now } : {}),
    assertCompatibility: () => goalPlanStore?.assertInteractiveEvidenceCompatible?.() === true });
  const stateStore = createInteractiveStateStore({ resultStore, ...(now ? { now } : {}) });
  const retention = createInteractiveRetention({ resultStore, stateStore, acquireRoots: acquireRetentionRoots,
    assertOwner: owner => enabled?.(owner.workspaceId) === true && holdsLease?.(owner.workspaceId) === true
      && getBotConversationId?.(owner.workspaceId) === owner.conversationId, ...(now ? { now } : {}) });
  const feedback = createInteractiveFeedbackAdmission({ stateStore });
  const publications = createInteractivePublicationSource({ resultStore, goalPlanStore, getBotConversationId, getSession });
  const verification = createInteractiveVerification({ resultStore, feedback, goalPlanStore, conversationStore, getBotConversationId, holdsLease, enabled });
  const authority = createInteractiveAuthority({ goalPlanStore, conversationStore, resultStore, getBotConversationId, holdsLease, enabled, classifyContext,
    readResourceFeedback: feedback.restore, resolveVerification: verification.resolve });
  const userMaterials = createInteractiveUserMaterials({ conversationStore });
  const materialSource = createInteractiveMaterialSource({
    readToolResult: (source, execution) => resultStore.readMaterial(execution.owner, source),
    readMaterialMetadata: readMaterialMetadata ?? ((source, execution) => resultStore.readMaterial(execution.owner, source)
      ?? (source.kind === 'user-material' ? userMaterials.read(source, execution) : null)),
    readUserMaterial: readUserMaterial ?? ((source, execution) => {
      const saved = resultStore.readMaterial(execution.owner, source);
      if (saved) return saved;
      const record = userMaterials.read(source, execution);
      if (!record) return null;
      const levels = ['D0_public', 'D1_internal', 'D2_sensitive', 'D3_private', 'D4_regulated'];
      if (execution.approvedDataLevel && levels.indexOf(record.dataLevel) > levels.indexOf(execution.approvedDataLevel)) throw Object.assign(Error('material_classification_changed'), { code: 'material_classification_changed' });
      resultStore.recordMaterial({ ...record, owner: execution.owner,
        source: { kind: 'user-material', messageId: source.messageId, attachmentId: source.attachmentId } }, execution.assertCurrent);
      return resultStore.readMaterial(execution.owner, source);
    }),
    admitSource: (source, execution, selector) => execution.assertCurrent() === true && execution.admitMaterial(source, selector) === true,
    ...(now ? { now } : {}),
  });
  const provider = createInteractiveResultProvider({ store: resultStore, stateStore, materialSource, resolveAuthority: authority.resolve,
    index: goalPlanStore, ...(now ? { now } : {}), ...(validate ? { validate } : {}) });
  return { resultStore, stateStore, retention, provider, authority, feedback, verification, publications, captureExecution: createInteractiveCapture({ resultStore, resolveAuthority: authority.resolve,
    resolveObservationAuthority: authority.resolveObservation, ...(now ? { now } : {}) }),
    userMaterialNotices(toolContext) {
      try { const context = authority.resolve({ toolContext });
        const notices = context.role === 'session_worker' && context.assertCurrent() === true ? userMaterials.list(context) : [];
        const levels = ['D0_public', 'D1_internal', 'D2_sensitive', 'D3_private', 'D4_regulated'];
        const classified = notices.flatMap(notice => {
          try {
            const original = resultStore.readMaterial(context.owner, notice.source);
            if (!original) return [notice];
            if (!levels.includes(original.dataLevel) || typeof original.truncated !== 'boolean' || typeof original.redacted !== 'boolean') return [];
            return [{ ...notice, dataLevel: levels[Math.max(levels.indexOf(notice.dataLevel), levels.indexOf(original.dataLevel))],
              truncated: notice.truncated || original.truncated, redacted: notice.redacted || original.redacted }];
          } catch { return []; }
        });
        return context.assertCurrent() === true ? classified : []; }
      catch { return []; }
    },
    recoverOwner(owner) { return provider.recoverOwner(owner, candidate => holdsLease?.(candidate.workspaceId) === true
      && getBotConversationId?.(candidate.workspaceId) === candidate.conversationId); },
    recoverWorkspace(workspaceId) {
      const owner = normalizeInteractiveOwner({ workspaceId, conversationId: getBotConversationId?.(workspaceId) });
      if (!owner || holdsLease?.(workspaceId) !== true) return { ok: false, code: 'interactive_scope_denied' };
      try { return { ok: true, items: provider.recoverOwner(owner, () => holdsLease(workspaceId) === true
        && getBotConversationId(workspaceId) === owner.conversationId) }; }
      catch (error) { return { ok: false, code: error.code ?? 'publication_unknown' }; }
    },
    close() { verification.dispose(); stateStore.close(); resultStore.close(); } };
}
