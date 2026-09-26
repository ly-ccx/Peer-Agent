/**
 * 带 delegationOrigin 的 GoalPlan 是任务。
 * 任务回合使用开任务时冻结的模型；没有快照时由调用方传入 B1-09 的解析结果。
 * L1 内嵌浏览器的 capabilityId 前缀是 local.web.control.，不是卡片草稿里的 local.browser.。
 */
export const WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES = Object.freeze([
  'local.web.control.',
]);

const SNAPSHOT_SLOT = Object.freeze({
  worker: 'worker',
  explorer: 'explorer',
  verifier: 'verifier',
  visual_verifier: 'visualVerifier',
});

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function frozenSelection(slot) {
  const modelProviderId = text(slot?.modelProviderId);
  if (!modelProviderId) return null;
  return {
    modelProviderId,
    ...(text(slot.providerId) ? { providerId: text(slot.providerId) } : {}),
    ...(text(slot.modelId) ? { modelId: text(slot.modelId) } : {}),
    ...(text(slot.family) ? { family: text(slot.family) } : {}),
    ...(text(slot.reasoningEffort) ? { reasoningEffort: text(slot.reasoningEffort) } : {}),
    ...(typeof slot.sameFamilyAsWorker === 'boolean'
      ? { sameFamilyAsWorker: slot.sameFamilyAsWorker }
      : {}),
    source: 'task',
  };
}

export function isDelegatedWorkSession(plan) {
  return Boolean(plan?.delegationOrigin) && typeof plan.delegationOrigin === 'object'
    && !Array.isArray(plan.delegationOrigin);
}

/**
 * 不是任务时返回 null，宿主保持原来的回合画像。
 * 快照里有这一角色就用快照，并且不再询问 routeRole。
 * 没有快照时：执行回合用会话模型；Explorer / Verifier / 视觉复核走 routeRole（B1-09）。
 */
export function resolveDelegatedWorkTurn(plan, kind, {
  conversationModelProviderId = null,
  routeRole = null,
} = {}) {
  if (!isDelegatedWorkSession(plan)) return null;
  const frozen = resolveWorkSessionProfile({ plan, kind, fallback: null });
  if (frozen?.modelSelection?.source === 'task') {
    return {
      turnProfile: frozen,
      modelProviderId: frozen.modelSelection.modelProviderId,
    };
  }
  let fallback = null;
  if (kind === 'worker') {
    const modelProviderId = text(conversationModelProviderId);
    fallback = modelProviderId ? { modelSelection: { modelProviderId } } : null;
  } else if (typeof routeRole === 'function') {
    const routed = routeRole(kind);
    if (!routed?.ok) return { error: routed || { ok: false, missing: '没有可用的模型' } };
    const selection = routed.selection?.modelProviderId
      ? {
          ...routed.selection,
          ...(routed.source ? { source: routed.source } : {}),
          ...(typeof routed.sameFamilyAsWorker === 'boolean'
            ? { sameFamilyAsWorker: routed.sameFamilyAsWorker }
            : {}),
        }
      : null;
    fallback = {
      ...(selection ? { modelSelection: selection } : {}),
      ...(Array.isArray(routed.candidateIds) && routed.candidateIds.length
        ? { recoveryCandidateIds: routed.candidateIds }
        : {}),
    };
  }
  const turnProfile = resolveWorkSessionProfile({ plan, kind, fallback });
  return {
    turnProfile,
    modelProviderId: turnProfile?.modelSelection?.modelProviderId ?? null,
  };
}

export function resolveWorkSessionProfile({ plan, kind = 'worker', fallback = null } = {}) {
  if (!isDelegatedWorkSession(plan)) return null;
  const origin = plan.delegationOrigin;
  const slotName = SNAPSHOT_SLOT[kind] || 'worker';
  const frozen = frozenSelection(origin.modelSelection?.[slotName]);
  const fallbackSelection = !frozen && fallback?.modelSelection?.modelProviderId
    ? fallback.modelSelection
    : null;
  const modelSelection = frozen || fallbackSelection;
  const workspaceId = text(origin.workspaceId) || text(plan.workspaceId);
  const sessionId = text(origin.sessionId) || text(plan.sessionId) || text(plan.planId);
  const memorySnapshotId = text(origin.memorySnapshotId);
  const planId = text(plan.planId);
  return {
    role: 'work_session',
    ...(workspaceId ? { workspaceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(planId ? { planId } : {}),
    ...(memorySnapshotId ? { memorySnapshotId } : {}),
    excludeCapabilityPrefixes: [...WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES],
    ...(modelSelection ? { modelSelection } : {}),
    ...(!frozen && Array.isArray(fallback?.recoveryCandidateIds) && fallback.recoveryCandidateIds.length
      ? { recoveryCandidateIds: [...fallback.recoveryCandidateIds] }
      : {}),
  };
}
