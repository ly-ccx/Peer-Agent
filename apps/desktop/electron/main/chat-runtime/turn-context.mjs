import { createMemoryStore, readSnapshots } from "@peer-agent/runtime-node/project-agent";

const TURN_ROLES = new Set([
  'user_chat',
  'goal_runner',
  'explorer',
  'verifier',
  'visual_verifier',
  'automation',
  'project_agent',
  'work_session',
  'memory_curator',
  'objective_probe',
]);

export function normalizeTurnProfile(value) {
  if (!value || typeof value !== 'object') return null;
  const role = TURN_ROLES.has(value.role) ? value.role : null;
  if (!role) return null;
  const modelProviderId = typeof value.modelSelection?.modelProviderId === 'string'
    ? value.modelSelection.modelProviderId.trim()
    : '';
  const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId.trim() : '';
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
  const planId = typeof value.planId === 'string' ? value.planId.trim() : '';
  const workId = typeof value.workId === 'string' ? value.workId.trim() : '';
  const memorySnapshotId = typeof value.memorySnapshotId === 'string' ? value.memorySnapshotId.trim() : '';
  const excludeCapabilityPrefixes = Array.isArray(value.excludeCapabilityPrefixes)
    ? value.excludeCapabilityPrefixes.filter((prefix) => typeof prefix === 'string' && prefix.trim()).map((prefix) => prefix.trim())
    : [];
  const recoveryCandidateIds = Array.isArray(value.recoveryCandidateIds)
    ? value.recoveryCandidateIds
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim())
    : [];
  const modelSelection = modelProviderId
    ? {
        modelProviderId,
        ...(typeof value.modelSelection.providerId === 'string' && value.modelSelection.providerId.trim()
          ? { providerId: value.modelSelection.providerId.trim() }
          : {}),
        ...(typeof value.modelSelection.modelId === 'string' && value.modelSelection.modelId.trim()
          ? { modelId: value.modelSelection.modelId.trim() }
          : {}),
        ...(typeof value.modelSelection.family === 'string' && value.modelSelection.family.trim()
          ? { family: value.modelSelection.family.trim() }
          : {}),
        ...(typeof value.modelSelection.reasoningEffort === 'string' ? { reasoningEffort: value.modelSelection.reasoningEffort } : {}),
        ...(typeof value.modelSelection.fastMode === 'boolean' ? { fastMode: value.modelSelection.fastMode } : {}),
        ...(typeof value.modelSelection.source === 'string' && value.modelSelection.source.trim()
          ? { source: value.modelSelection.source.trim() }
          : {}),
        ...(typeof value.modelSelection.sameFamilyAsWorker === 'boolean'
          ? { sameFamilyAsWorker: value.modelSelection.sameFamilyAsWorker }
          : {}),
      }
    : null;
  const binding = value.coordinationBinding;
  const coordinationBinding = binding && binding.workId === workId && Number.isSafeInteger(binding.goalRevision) && binding.goalRevision >= 0
    && typeof binding.executionEpoch === 'string' && binding.executionEpoch.trim() && binding.executionEpoch.length <= 200
    && (!binding.sessionId || binding.sessionId === sessionId)
    ? { workId, goalRevision: binding.goalRevision, executionEpoch: binding.executionEpoch, ...(binding.sessionId ? { sessionId } : {}) } : null;
  const context = sanitizeTurnContext(value.context);
  return {
    role,
    ...(typeof value.agentKind === 'string' ? { agentKind: value.agentKind } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(planId ? { planId } : {}),
    ...(workId ? { workId } : {}),
    ...(coordinationBinding ? { coordinationBinding } : {}),
    ...(memorySnapshotId ? { memorySnapshotId } : {}),
    ...(excludeCapabilityPrefixes.length ? { excludeCapabilityPrefixes } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(recoveryCandidateIds.length ? { recoveryCandidateIds } : {}),
    ...(context ? { context } : {}),
  };
}

const TURN_CONTEXT_JSON_MAX = 200_000;

function sanitizeTurnContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let raw = '';
  try {
    raw = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!raw || raw.length > TURN_CONTEXT_JSON_MAX) return null;
  const cloned = JSON.parse(raw);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return null;
  return cloned;
}

export function textField(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function explicitArray(value) {
  return Array.isArray(value) ? value : null;
}

function loadProjectMemory(workspaceId) {
  try {
    return createMemoryStore().list({ workspaceId, status: 'active' });
  } catch {
    return [];
  }
}

function loadSnapshotItems(workspaceId, snapshotId) {
  if (!workspaceId || !snapshotId) return [];
  try {
    const store = createMemoryStore();
    const snapshot = readSnapshots(workspaceId, { store })
      .find((item) => item.snapshotId === snapshotId);
    if (!snapshot) return [];
    if (Array.isArray(snapshot.items) && snapshot.items.length) {
      return snapshot.items.map((item) => ({ ...item }));
    }
    const items = [];
    for (const id of snapshot.itemIds) {
      const item = store.get(id);
      if (item) items.push(item);
    }
    return items;
  } catch {
    return [];
  }
}

function readDelegatedPlan(goalPlanStore, profile, conversationId) {
  if (!goalPlanStore) return null;
  try {
    if (profile?.planId && typeof goalPlanStore.getPlan === 'function') {
      const plan = goalPlanStore.getPlan(profile.planId);
      if (plan) return plan;
    }
    if (conversationId && typeof goalPlanStore.getActivePlanByConversation === 'function') {
      return goalPlanStore.getActivePlanByConversation(conversationId) ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function readAnchorText(conversationStore, origin) {
  const anchorId = textField(origin?.anchorMessageId);
  const parentId = textField(origin?.parentConversationId);
  if (!anchorId || !parentId || !conversationStore) return '';
  try {
    const history = conversationStore.getPersistedConversationHistory?.(parentId)
      ?? conversationStore.getConversation?.(parentId);
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    const message = messages.find((item) => item?.id === anchorId);
    return typeof message?.content === 'string' ? message.content : '';
  } catch {
    return '';
  }
}

/**
 * 把已有 turnProfile 上的上下文交给 assembleSystemContext。
 * 不增加 sendMessage 参数。名册和事件留在 context 袋里；
 * 记忆与冻结快照在袋里没有显式条目时，才按 workspaceId 从本地记忆读取。
 */
export function projectTurnSystemContext(profile, {
  conversationId = null,
  goalPlanStore = null,
  conversationStore = null,
  readMemory = loadProjectMemory,
  readSnapshot = loadSnapshotItems,
  memoryEnabled = true,
} = {}) {
  if (profile?.role !== 'project_agent' && profile?.role !== 'work_session') return {};
  const useMemory = memoryEnabled !== false;
  const turnContext = sanitizeTurnContext(profile.context);
  const fields = {
    role: profile.role,
    ...(profile.agentKind ? { agentKind: profile.agentKind } : {}),
    ...(textField(profile.workspaceId) ? { workspaceId: textField(profile.workspaceId) } : {}),
    ...(textField(profile.sessionId) ? { sessionId: textField(profile.sessionId) } : {}),
    ...(textField(profile.planId) ? { planId: textField(profile.planId) } : {}),
    ...(textField(profile.memorySnapshotId) ? { memorySnapshotId: textField(profile.memorySnapshotId) } : {}),
    ...(turnContext ? { turnContext } : {}),
  };
  if (profile.role === 'project_agent' && useMemory) {
    const injected = explicitArray(turnContext?.projectMemory)
      ?? explicitArray(turnContext?.memoryItems)
      ?? explicitArray(turnContext?.items);
    if (injected) fields.projectMemory = injected;
    else if (textField(profile.workspaceId)) {
      const loaded = readMemory(textField(profile.workspaceId));
      if (Array.isArray(loaded) && loaded.length) fields.projectMemory = loaded;
    }
  }
  if (profile.role === 'work_session') {
    const plan = readDelegatedPlan(goalPlanStore, profile, conversationId);
    const origin = plan?.delegationOrigin && typeof plan.delegationOrigin === 'object'
      ? plan.delegationOrigin
      : {};
    fields.workSessionExecution = { phase: origin.phase,
      ...(origin.coordinationBinding ? {goalRevision: origin.coordinationBinding.goalRevision} : {}),
      ...(origin.takeover?.text ? {takeover: origin.takeover.text} : {}) };
    const bag = turnContext?.workSessionOrigin && typeof turnContext.workSessionOrigin === 'object'
      ? turnContext.workSessionOrigin
      : {};
    const snapshotId = textField(bag.memorySnapshotId)
      || textField(profile.memorySnapshotId)
      || textField(origin.memorySnapshotId);
    const injectedItems = explicitArray(bag.snapshotItems) ?? explicitArray(bag.items);
    const snapshotItems = useMemory
      ? (injectedItems
        ?? (snapshotId && textField(profile.workspaceId)
          ? readSnapshot(textField(profile.workspaceId), snapshotId)
          : []))
      : [];
    const readOnly = typeof bag.readOnly === 'boolean' ? bag.readOnly : origin.readOnly === true;
    const summary = textField(bag.summary) || textField(bag.brief) || textField(plan?.goal);
    const anchorText = textField(bag.anchorText) || readAnchorText(conversationStore, origin);
    const workSessionOrigin = {
      ...(summary ? { summary } : {}),
      ...(anchorText ? { anchorText } : {}),
      ...(textField(bag.anchorMessageId) || textField(origin.anchorMessageId)
        ? { anchorMessageId: textField(bag.anchorMessageId) || textField(origin.anchorMessageId) }
        : {}),
      ...(snapshotId ? { memorySnapshotId: snapshotId } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      snapshotItems: Array.isArray(snapshotItems) ? snapshotItems : [],
    };
    const hasFacts = summary || anchorText || snapshotId || workSessionOrigin.snapshotItems.length || readOnly;
    if (hasFacts) fields.workSessionOrigin = workSessionOrigin;
  }
  return fields;
}
