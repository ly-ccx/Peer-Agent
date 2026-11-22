import { normalizeSessionExecutionIdentity, normalizeInteractiveReviewBinding } from '@peer-agent/protocol';

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
  const identity = normalizeSessionExecutionIdentity(value.executionIdentity);
  const execution = identity?.planId === planId && identity.sessionId === sessionId ? identity : null;
  const interactiveReview = normalizeInteractiveReviewBinding(value.interactiveReview);
  return {
    role,
    ...(typeof value.agentKind === 'string' ? { agentKind: value.agentKind } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(planId ? { planId } : {}),
    ...(execution ? { executionIdentity: execution } : {}),
    ...(interactiveReview ? { interactiveReview } : {}),
    ...(workId ? { workId } : {}),
    ...(coordinationBinding ? { coordinationBinding } : {}),
    ...(memorySnapshotId ? { memorySnapshotId } : {}),
    ...(excludeCapabilityPrefixes.length ? { excludeCapabilityPrefixes } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(recoveryCandidateIds.length ? { recoveryCandidateIds } : {}),
    ...(context ? { context } : {}),
  };
}
