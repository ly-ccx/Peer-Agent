import { createHash } from 'node:crypto';
const CAPABILITY_ID = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/;
export function validCapabilityRequirements(value) {
  return Array.isArray(value) && value.length <= 32
    && value.every(id => typeof id === 'string' && id.length <= 160 && CAPABILITY_ID.test(id))
    && new Set(value).size === value.length;
}
/** Requirements can narrow admission, never provide authority or widen a projection. */
export function delegationCapabilityRequirements(input = {}) {
  const required = new Set(input.requiredCapabilities || []), criterionIds = new Map();
  for (const [index, criterion] of (input.successCriteria || []).entries()) {
    const ids = new Set(criterion.requiredCapabilities || []);
    if (['command', 'test'].includes(criterion.kind)) ids.add('local.shell.exec');
    if (['file-contains', 'file-exists'].includes(criterion.kind)) ids.add('local.file.read');
    for (const id of ids) { required.add(id); criterionIds.set(id, [...(criterionIds.get(id) || []), criterion.id || `c${index + 1}`]); }
  }
  return { required: [...required].sort(), criterionIds };
}
export function evaluateDelegationCapabilities(input, availableCapabilities) {
  const { required, criterionIds } = delegationCapabilityRequirements(input);
  const known = Array.isArray(availableCapabilities);
  const available = known ? [...new Set(availableCapabilities)].sort() : [];
  const missing = required.filter(id => !available.includes(id));
  if (!missing.length) return { ok: true, required, available, inventoryKnown: known,
    inventoryHash: known ? createHash('sha256').update(JSON.stringify(available)).digest('hex') : null,
    requirementsDeclared: Array.isArray(input.requiredCapabilities) };
  const error = known ? 'delegation_capability_unavailable' : 'delegation_capability_unknown';
  return { ok: false, error, message: '宿主无法为该任务提供验收所需能力；未创建或启动任务，原验收范围和既有任务保持不变。',
    diagnostic: { stage: 'delegation_admission', reason: error, required, available, missing,
      criterionIds: [...new Set(missing.flatMap(id => criterionIds.get(id) || []))],
      alternatives: missing.includes('local.shell.exec') ? ['Use local.git.query for Git observations; command/test criteria require an execution-capable worker.'] : [],
      retryable: false, userActionRequired: false },
  };
}
