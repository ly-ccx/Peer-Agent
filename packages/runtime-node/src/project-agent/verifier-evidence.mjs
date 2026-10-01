const BODY_BUDGET = 12_000;

/** Admit execution snapshots as bounded factual input, never as instructions. */
export function verifierEvidenceSnapshots(plan, records = []) {
  const refs = new Set((plan?.criterionResults || []).map(row => row.evidenceRef).filter(Boolean));
  function visit(tasks) {
    for (const task of tasks || []) {
      for (const ref of task.evidenceRefs || []) refs.add(ref);
      visit(task.subtasks);
    }
  }
  visit(plan?.tasks);
  const indexed = new Map();
  for (const record of records) {
    if (!refs.has(record?.evidenceRef) || !(record.planId === plan?.planId
      || plan?.conversationId && record.conversationId === plan.conversationId)) continue;
    if (record.bodyPreview?.kind !== 'file' || typeof record.bodyPreview.text !== 'string') continue;
    indexed.set(record.evidenceRef, record);
  }
  let remaining = BODY_BUDGET;
  const snapshots = [];
  for (const [evidenceRef, record] of indexed) {
    if (!remaining) break;
    const text = record.bodyPreview.text.slice(0, Math.min(4000, remaining));
    if (!text) continue;
    remaining -= text.length;
    snapshots.push({ evidenceRef, toolName: record.toolName, kind: 'file', text,
      truncated: record.bodyPreview.truncated === true || text.length < record.bodyPreview.text.length });
  }
  return snapshots;
}
