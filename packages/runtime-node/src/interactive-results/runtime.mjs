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
import { createPortableInteractiveSummaryReader } from './portable-summary.mjs';
import { createDelegationRetention } from './delegation-retention.mjs';
import { createInteractiveRetentionRoots } from './retention-roots.mjs';
import { createInteractiveRetention } from './retention.mjs';
import { executionIdentity, sameExecution } from '../project-agent/session-control-kernel.mjs';
import { sessionFactsFromPlan } from '../project-agent/session-facts.mjs';
import { workBudgetBinding } from '../project-agent/work-budget.mjs';

/** One shared domain instance per host. Composition roots supply real local facts. */
export function createInteractiveRuntime({ rootDir, goalPlanStore, conversationStore, getBotConversationId,
  holdsLease, enabled, classifyContext, readUserMaterial, readMaterialMetadata, readPortableWorkHistory, getSession, now, validate, retentionPorts } = {}) {
  const resultStore = createInteractiveResultStore({ ...(rootDir ? { rootDir } : {}), ...(now ? { now } : {}),
    assertCompatibility: () => goalPlanStore?.assertInteractiveEvidenceCompatible?.() === true });
  const stateStore = createInteractiveStateStore({ resultStore, ...(now ? { now } : {}) });
  const assertOwner = owner => enabled?.(owner.workspaceId) === true && holdsLease?.(owner.workspaceId) === true
    && getBotConversationId?.(owner.workspaceId) === owner.conversationId;
  const acquireDelegationRoots = createDelegationRetention({ goalPlanStore, resultStore, stateStore, assertOwner });
  const feedback = createInteractiveFeedbackAdmission({ stateStore, conversationStore });
  const readPortableSummary = createPortableInteractiveSummaryReader({ goalPlanStore, readWorkHistory: readPortableWorkHistory });
  const publications = createInteractivePublicationSource({ resultStore, goalPlanStore, getBotConversationId, getSession, readPortableSummary });
  const verification = createInteractiveVerification({ resultStore, feedback, goalPlanStore, conversationStore, getBotConversationId, holdsLease, enabled });
  const acquireRoots = createInteractiveRetentionRoots({ ...retentionPorts, feedback, acquireDelegationRoots, verification });
  const retention = createInteractiveRetention({ resultStore, stateStore, acquireRoots, assertOwner, ...(now ? { now } : {}) });
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
  const preparationCursors = new Map();
  function recoverOwner(owner) {
    const owns = () => holdsLease?.(owner.workspaceId) === true && getBotConversationId?.(owner.workspaceId) === owner.conversationId;
    const items = provider.recoverOwner(owner, owns);
    const journal = workBudgetBinding(owner.workspaceId)?.store;
    if (!journal?.readSessionControl) return items;
    function stopped({ source }) {
      if (!owns()) return false;
      const plan = goalPlanStore.getPlan(source.planId);
      const origin = plan?.delegationOrigin;
      if (origin?.workspaceId !== owner.workspaceId || origin.parentConversationId !== owner.conversationId
        || plan.conversationId !== source.conversationId || origin.sessionId !== source.sessionId) return false;
      const currentExecution = sameExecution(source, executionIdentity(plan));
      if (currentExecution && sessionFactsFromPlan(plan).executionOwnership === 'live') return false;
      const control = currentExecution ? journal.readSessionControl(source.sessionId) : journal.readStoppedExecution?.(source);
      const receipt = control?.stopReceipt;
      return control?.workspaceId === owner.workspaceId && control.parentConversationId === owner.conversationId
        && control.planId === source.planId && control.sessionId === source.sessionId && ['pause', 'cancel', 'takeover'].includes(control.kind)
        && sameExecution(source, control.expectedExecution) && sameExecution(source, receipt?.execution)
        && receipt.operationId === control.operationId && receipt.scope === 'managed_execution'
        && receipt.admissionClosed === true && receipt.runnerIdle === true && receipt.schedulerIdle === true && owns();
    }
    const cursor = preparationCursors.get(owner.workspaceId);
    const page = resultStore.listPrepared(owner, cursor?.conversationId === owner.conversationId ? cursor.after : '');
    for (const row of page) {
      if (!stopped(row)) continue;
      const ended = resultStore.reconcileStoppedPreparation(row.callRef, stopped);
      if (ended) items.push({ callRef: ended.callRef, publicationStatus: 'not_committed', code: ended.code });
    }
    if (page.length === 32) preparationCursors.set(owner.workspaceId, { conversationId: owner.conversationId, after: page.at(-1).cursor });
    else preparationCursors.delete(owner.workspaceId);
    return items;
  }
  return { resultStore, stateStore, retention, acquireDelegationRoots, provider, authority, feedback, verification, publications, readPortableSummary, captureExecution: createInteractiveCapture({ resultStore, resolveAuthority: authority.resolve,
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
    recoverOwner,
    recoverWorkspace(workspaceId) {
      const owner = normalizeInteractiveOwner({ workspaceId, conversationId: getBotConversationId?.(workspaceId) });
      if (!owner || holdsLease?.(workspaceId) !== true) return { ok: false, code: 'interactive_scope_denied' };
      try { return { ok: true, items: recoverOwner(owner) }; }
      catch (error) { return { ok: false, code: error.code ?? 'publication_unknown' }; }
    },
    close() { verification.dispose(); stateStore.close(); resultStore.close(); } };
}
