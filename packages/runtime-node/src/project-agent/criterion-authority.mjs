const KINDS = new Set(['command', 'test', 'file-contains', 'file-exists', 'model_review', 'manual']);

/** Host admission. Authority is supplied by a trusted policy/input adapter, never model arguments. */
export function admitDelegationCriteria(items, { anchorMessageIds = [], manualAuthorities = [] } = {}) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 8) return { ok: false, error: 'invalid_criteria' };
  const ids = new Set();
  const criteria = [];
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !KINDS.has(item.kind)
      || typeof item.description !== 'string' || !item.description.trim()
      || Object.keys(item).some(key => !['id', 'kind', 'description', 'command', 'path', 'expect'].includes(key))) {
      return { ok: false, error: 'invalid_criteria' };
    }
    if (item.description.length > 500 || item.id !== undefined && (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200)
      || ['command', 'test'].includes(item.kind) && (typeof item.command !== 'string' || !item.command.trim() || item.command.length > 2000)
      || ['file-contains', 'file-exists'].includes(item.kind) && (typeof item.path !== 'string' || !item.path.trim() || item.path.length > 1000)
      || item.kind === 'file-contains' && (typeof item.expect !== 'string' || !item.expect || item.expect.length > 2000)) return { ok: false, error: 'invalid_criteria' };
    const id = item.id || `c${index + 1}`;
    if (ids.has(id)) return { ok: false, error: 'duplicate_criterion' };
    ids.add(id);
    const authority = item.kind === 'manual' ? manualAuthorities.find(row => row.criterionId === id
      && ['user', 'project_policy'].includes(row.source)
      && typeof row.sourceRef === 'string' && row.sourceRef
      && (row.source === 'project_policy' || anchorMessageIds.includes(row.sourceRef))) : null;
    if (item.kind === 'manual' && !authority) return { ok: false, error: 'manual_authority_required', criterionId: id };
    criteria.push({ ...item, id, description: item.description.trim(), authority: {
      source: authority?.source || 'model', sourceRef: authority?.sourceRef || anchorMessageIds[0],
      version: 1, verifier: item.kind === 'manual' ? 'human' : item.kind === 'model_review' ? 'host_model' : 'mechanical',
      rationale: authority?.rationale || 'Structured delegation criterion',
    } });
  }
  return { ok: true, criteria };
}
