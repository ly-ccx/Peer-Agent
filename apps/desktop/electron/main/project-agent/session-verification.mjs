/**
 * 把桌面宿主的计划、证据索引和 verifier 运行入口收成委托工具的 verification 端口。
 * 工具每次调用时再读取当前端口，所以启动顺序不必先于 Local Tool Host。
 */
import { readdirSync } from 'node:fs';

let current = null;

export function installSessionVerification(port) {
  current = port && typeof port === 'object' ? port : null;
}

export function liveSessionVerification() {
  return {
    available: () => current != null,
    facts: (sessionId) => current.facts(sessionId),
    run: (input) => current.run(input),
    markVerifying: (sessionId) => current.markVerifying?.(sessionId),
    record: (input) => current.record?.(input),
  };
}

export function createSessionVerification({
  goalPlanStore,
  verifySession,
  appendMessage = null,
} = {}) {
  function findPlan(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id || typeof goalPlanStore?.getStoreDir !== 'function' || typeof goalPlanStore?.getPlan !== 'function') {
      return null;
    }
    let names = [];
    try {
      names = readdirSync(goalPlanStore.getStoreDir());
    } catch {
      return null;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let plan = null;
      try {
        plan = goalPlanStore.getPlan(name.slice(0, -'.json'.length));
      } catch {
        plan = null;
      }
      if (plan?.delegationOrigin?.sessionId === id) return plan;
    }
    return null;
  }

  function evidenceRecords(plan) {
    if (typeof goalPlanStore?.listEvidenceIndex !== 'function') return [];
    let records = [];
    try {
      records = goalPlanStore.listEvidenceIndex() || [];
    } catch {
      return [];
    }
    const conversationId = plan?.conversationId;
    return records.filter((record) => record?.planId === plan?.planId
      || (conversationId && record?.conversationId === conversationId));
  }

  function factsFor(plan, authority = {}) {
    const records = evidenceRecords(plan);
    const evidenceIndex = records
      .map((record) => record?.evidenceRef)
      .filter((ref) => typeof ref === 'string' && ref.trim());
    const stored = plan?.hostVerification && typeof plan.hostVerification === 'object'
      ? plan.hostVerification
      : {};
    const selection = plan?.delegationOrigin?.modelSelection;
    const workerModel = modelLabel(selection?.worker);
    const verifierModel = typeof authority.verifierModel === 'string'
      ? authority.verifierModel
      : (typeof stored.verifierModel === 'string' ? stored.verifierModel : modelLabel(selection?.verifier));
    const sameFamily = typeof authority.sameFamilyAsWorker === 'boolean'
      ? authority.sameFamilyAsWorker
      : (typeof stored.sameFamilyAsWorker === 'boolean'
        ? stored.sameFamilyAsWorker
        : selection?.verifier?.sameFamilyAsWorker === true);
    const independentVerifier = authority.independentVerifier
      || stored.independentVerifier
      || 'missing';
    const allowed = new Set(evidenceIndex);
    const outputs = [];
    for (const record of records) {
      const evidenceRef = typeof record?.evidenceRef === 'string' ? record.evidenceRef.trim() : '';
      if (!evidenceRef || !allowed.has(evidenceRef)) continue;
      const text = previewText(record);
      if (!text) continue;
      outputs.push({
        evidenceRef,
        name: typeof record.toolName === 'string' && record.toolName.trim() ? record.toolName.trim() : 'output',
        text,
      });
    }
    return {
      plan,
      evidenceIndex,
      independentVerifier,
      ...(workerModel ? { workerModel } : {}),
      ...(verifierModel ? { verifierModel } : {}),
      sameFamilyAsWorker: sameFamily,
      outputs,
    };
  }

  return {
    async facts(sessionId) {
      const plan = findPlan(sessionId);
      if (!plan) return null;
      return factsFor(plan);
    },
    async markVerifying(sessionId) {
      const plan = findPlan(sessionId);
      if (!plan?.delegationOrigin || typeof goalPlanStore?.revisePlan !== 'function') return null;
      return goalPlanStore.revisePlan(plan.planId, {
        delegationOrigin: { ...plan.delegationOrigin, verifying: true },
      }, { reason: 'independent verification', changedBy: 'session-verification' });
    },
    async run(input = {}) {
      const plan = findPlan(input.sessionId);
      if (!plan) return { ok: false, error: 'session_not_found' };
      if (typeof verifySession !== 'function') return { ok: false, error: 'verifier_unavailable' };
      let report = null;
      try {
        report = await verifySession(plan, input.focus);
      } catch {
        return { ok: false, error: 'verifier_failed' };
      }
      if (!report || report.ok === false || typeof report.passed !== 'boolean') {
        return { ok: false, error: report?.error || 'verifier_failed' };
      }
      return {
        ok: true,
        at: new Date().toISOString(),
        facts: factsFor(plan, {
          independentVerifier: report.passed ? 'passed' : 'failed',
          ...(typeof report.verifierModel === 'string' ? { verifierModel: report.verifierModel } : {}),
          ...(typeof report.sameFamilyAsWorker === 'boolean' ? { sameFamilyAsWorker: report.sameFamilyAsWorker } : {}),
        }),
      };
    },
    async record({ event, card, detail } = {}) {
      const plan = findPlan(event?.sessionId || card?.sessionId);
      if (plan && typeof goalPlanStore?.revisePlan === 'function') {
        const stored = plan.hostVerification && typeof plan.hostVerification === 'object' ? plan.hostVerification : {};
        goalPlanStore.revisePlan(plan.planId, {
          delegationOrigin: { ...plan.delegationOrigin, verifying: true },
          hostVerification: {
            ...stored,
            independentVerifier: authorityFromDetail(detail, stored),
            ...(typeof detail?.verifierModel === 'string' ? { verifierModel: detail.verifierModel } : {}),
            ...(typeof detail?.sameSource === 'boolean' ? { sameFamilyAsWorker: detail.sameSource } : {}),
            verdictRef: event?.verdictRef || card?.verdictRef || '',
          },
        }, { reason: 'verification verdict', changedBy: 'session-verification' });
      }
      const conversationId = plan?.delegationOrigin?.parentConversationId || plan?.conversationId;
      if (typeof appendMessage === 'function' && conversationId && card) {
        const evidenceRefs = Array.isArray(detail?.outputs)
          ? detail.outputs.map((item) => item?.evidenceRef).filter((ref) => typeof ref === 'string' && ref)
          : [];
        appendMessage(conversationId, {
          id: card.cardId,
          role: 'assistant',
          kind: 'system_card',
          content: typeof card.content === 'string' ? card.content : '',
          cards: [card],
          sessionId: card.sessionId,
          meta: { evidenceRefs },
        });
      }
      return { ok: true };
    },
  };
}

function authorityFromDetail(detail, stored) {
  const check = Array.isArray(detail?.checks)
    ? detail.checks.find((item) => item?.name === 'independent_verifier')
    : null;
  if (check?.reason === 'failed' || check?.reason === 'missing') return check.reason;
  if (check?.result === 'passed') return 'passed';
  return stored.independentVerifier || 'missing';
}

function modelLabel(selection) {
  if (!selection || typeof selection !== 'object') return null;
  if (typeof selection.modelId === 'string' && selection.modelId.trim()) return selection.modelId.trim();
  if (typeof selection.modelProviderId === 'string' && selection.modelProviderId.trim()) return selection.modelProviderId.trim();
  return null;
}

function previewText(record) {
  const lines = [];
  for (const artifact of Array.isArray(record?.userArtifacts) ? record.userArtifacts : []) {
    const preview = artifact?.preview;
    if (preview?.kind === 'code' && Array.isArray(preview.diffLines)) {
      lines.push(...preview.diffLines.filter((line) => typeof line === 'string'));
    } else if (typeof artifact?.label === 'string' && artifact.label.trim()) {
      lines.push(artifact.label.trim());
    }
  }
  return lines.join('\n').trim();
}
