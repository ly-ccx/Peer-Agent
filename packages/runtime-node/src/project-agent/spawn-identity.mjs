import { createHash } from 'node:crypto';

const OPERATIONS = {
  'file-contains': ['path', 'expect'],
  'file-exists': ['path'],
  command: ['command'],
  test: ['command'],
};

// Automatic criteria describe the work independently of model-written prose.
// Manual-only requests retain the exact-request identity.
export function spawnIdentity(parentConversationId, input) {
  const criteria = Array.isArray(input.successCriteria) ? input.successCriteria : [];
  const automatic = criteria.length > 0 && criteria.every(item => item && OPERATIONS[item.kind]
    && OPERATIONS[item.kind].every(key => typeof item[key] === 'string' && item[key].trim()));
  const material = automatic ? {
    parentConversationId,
    ...(input.coordinationOperationId ? { coordinationOperationId: input.coordinationOperationId } : {}),
    ...(input.objectiveId ? {objectiveId:input.objectiveId} : {}),
    anchorMessageIds: [...new Set(input.anchorMessageIds || [])].sort(),
    kind: input.kind,
    readOnly: input.readOnly === true,
    successCriteria: criteria.map(item => Object.fromEntries(['kind', ...OPERATIONS[item.kind]]
      .map(key => [key, item[key]]))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    dependsOn: [...new Set(input.dependsOn || [])].sort(),
    supersedes: input.supersedes || '',
    isolation: input.isolation || 'auto',
  } : { parentConversationId, ...input };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export function identityFromPlan(plan, parentConversationId, request) {
  const origin = plan.delegationOrigin;
  if (origin?.parentConversationId !== parentConversationId) return '';
  const original = {
    anchorMessageIds: request.anchorMessageIds,
    title: plan.title, brief: plan.goal,
    kind: request.kind, readOnly: origin.readOnly === true,
    successCriteria: (plan.successCriteria || []).map(({ authority, ...criterion }) => criterion),
  };
  // Old plans did not persist kind or all anchors separately. The original
  // request hash must prove those values before deriving a new identity.
  if (request.supersedes || (request.isolation || 'auto') !== (origin.isolation || 'auto')) return '';
  const oldKey = createHash('sha256').update(JSON.stringify({ parentConversationId, ...original })).digest('hex');
  if (oldKey !== origin.idempotencyKey) return '';
  return spawnIdentity(parentConversationId, { ...original, dependsOn: origin.dependsOn, isolation: origin.isolation || 'auto' });
}
