type Fields = Record<string, unknown>;

function record(value: unknown): Fields | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
}

function identity(value: unknown, maxBytes = 200): string | undefined {
  return typeof value === 'string' && value.length && Buffer.byteLength(value) <= maxBytes ? value : undefined;
}

function boundedRows<T>(source: unknown, project: (value: unknown) => T | undefined, maxBytes: number) {
  const input: unknown[] = Array.isArray(source) ? source : [];
  const rows: T[] = [];
  let bytes = 2;
  for (const item of input) {
    const row = project(item);
    if (row === undefined) continue;
    bytes += Buffer.byteLength(JSON.stringify(row)) + Number(rows.length > 0);
    if (bytes > maxBytes) break;
    rows.push(row);
  }
  return { rows, omitted: input.length - rows.length };
}

function sessionState(value: unknown) {
  const row = record(value);
  const sessionId = identity(row?.sessionId), status = identity(row?.status);
  if (!sessionId || !status) return undefined;
  return { sessionId, status, sourceRevision: identity(row?.sourceRevision), observationRevision: identity(row?.observationRevision) };
}

/** Continuation facts from the scoped Delegation Provider result, before generic text materialization. */
export function projectDelegationContinuation(execution: unknown): { tool: string; facts: Fields; note: string } | undefined {
  const entry = record(execution);
  const call = record(entry?.call), result = record(entry?.result), output = record(result?.output);
  if (!call || result?.status !== 'success' || output?.ok !== true) return;

  if (call.capabilityId === 'local.delegation.coordinate_work' && record(output.decisionFrame)) {
    const workId = identity(output.workId), { workRevision, goalRevision } = output;
    if (!workId || !Number.isSafeInteger(workRevision) || !Number.isSafeInteger(goalRevision)) return;
    const inputs = boundedRows(output.sourceInputIds, item => identity(item), 1350);
    const events = boundedRows(output.sourceEventIds, item => identity(item), 1350);
    const intent = record(output.intent);
    const requirements = boundedRows(record(intent?.interpretation)?.requirements, item => identity(record(item)?.requirementId), 1350);
    return {
      tool: 'coordinate_work',
      facts: { workId, workRevision, goalRevision, currentReplyRef: identity(output.currentReplyRef),
        sourceDecisionRef: identity(output.sourceDecisionRef), sourceInputIds: inputs.rows, sourceEventIds: events.rows,
        requirementIds: intent ? requirements.rows : null,
        omitted: { sourceInputIds: inputs.omitted, sourceEventIds: events.omitted, requirementIds: requirements.omitted } },
      note: 'These are the structured revisions and source identities from this query. Use coordinate_work and get_session for scoped details.',
    };
  }

  if (call.capabilityId === 'local.delegation.get_session') {
    const state = sessionState(output);
    if (!state) return;
    const report = record(output.report);
    const refs = boundedRows(report?.evidenceRefs, item => identity(item, 1024), 3800);
    return {
      tool: 'get_session',
      facts: { ...state, ...(report ? { reportEvidenceRefs: refs.rows, omittedReportEvidenceRefs: refs.omitted } : {}) },
      note: 'These are the task state and evidence references from this read. Use get_verification_detail for the review checks.',
    };
  }

  if (call.capabilityId === 'local.delegation.list_sessions' && Array.isArray(output.sessions)) {
    const sessions = boundedRows(output.sessions, sessionState, 3800);
    return {
      tool: 'list_sessions',
      facts: { sessions: sessions.rows, omittedSessions: sessions.omitted },
      note: 'These are task states from this list. Use get_session for a specific task or list_sessions with a smaller limit.',
    };
  }
}
