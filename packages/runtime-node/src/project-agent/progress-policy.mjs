import { createHash } from 'node:crypto';

const volatile = /^(id|operationId|toolCallId|callId|attemptId|turnId|messageId|requestId|verifierRunId|continuationId|modelProviderId|workerModel|verifierModel|.*At|.*Ms|.*Ref|.*Refs|seq|version|revision|workRevision|goalRevision|executionEpoch|sourceRevision|observationRevision|payloadHash|duration|usage|timing|timestamp|reason|diagnostic)$/;
const identity = new Set(['sessionId', 'taskId', 'planId', 'workId', 'requirementId', 'capabilityId', 'path', 'target']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } };

/** Machine category wins. Free wording remains diagnostic and cannot reset a failure allowance. */
export function stableFailureClass(value) {
  if (value && typeof value === 'object') return stableFailureClass(value.code || value.kind || value.error || value.cause || value.message);
  const text = String(value || '').trim().toLowerCase();
  const code = text.match(/\b(err_[a-z0-9_]+|econn[a-z_]+|e[an]oent|eacces|eaddrinuse|[a-z]+(?:_[a-z0-9]+){1,})\b/);
  if (code) return code[1];
  if (/timeout|timed out|超时/.test(text)) return 'timeout';
  if (/network|socket|网络|连接/.test(text)) return 'network';
  if (/permission|denied|授权|权限/.test(text)) return 'permission';
  if (/bind|端口被占用/.test(text)) return 'binding_failed';
  if (/\b(401|403|429|500|502|503|504)\b/.test(text)) return `http_${text.match(/\b(401|403|429|500|502|503|504)\b/)[1]}`;
  return /^[a-z][a-z0-9_.:-]{0,79}$/.test(text) ? text : text ? 'unclassified_failure' : '';
}
export function normalizeProgressMaterial(value, key = '') {
  value = parse(value);
  if (Array.isArray(value)) return value.map(item => normalizeProgressMaterial(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(name => !volatile.test(name))
    .map(name => [name, ['error', 'blockedReason', 'lastError', 'cause'].includes(name) ? stableFailureClass(value[name]) : normalizeProgressMaterial(value[name], name)]));
  if (typeof value !== 'string' || identity.has(key)) return value;
  return value.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>').replace(/\bcall_[A-Za-z0-9_-]{12,}/g, 'call_<id>')
    .replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z\b/g, '<time>');
}
// Query spill files are transport copies, not new task results. A partial preview
// cannot prove changed semantics; its full Tool Result and Evidence stay untouched.
function queryArtifactObservation(call, output) {
  if (call?.name !== 'read_file') return null;
  const path = call.input?.path;
  const query = typeof path === 'string' && /[\\/]artifacts[\\/]/.test(path)
    ? path.match(/[\\/](get_session|get_verification_detail|coordinate_work)-call_[A-Za-z0-9_-]+\.txt$/)?.[1] : null;
  if (!query || output?.kind !== 'local_file_ref' || output.tool !== 'read_file') return null;
  if (output.contextPreviewTruncated !== true && output.truncated !== true && typeof output.preview === 'string') {
    // read_file presents numbered lines. Remove only the presentation prefix.
    const text = output.preview.replace(/^\s*\d+\t/gm, '');
    const material = parse(text);
    if (material && typeof material === 'object' && !Array.isArray(material)) {
      const observation = progressObservation({ name: query, result: material });
      // Reading a file cannot turn its copied receipt into a new execution fact.
      return observation ? { ...observation, kind: 'observed' } : null;
    }
  }
  return { kind: 'observed', fact: { name: 'read_query_artifact', query, material: 'partial_or_unavailable' } };
}
export function progressObservation(call) {
  const result = parse(call?.result), output = parse(result?.output) || result;
  const artifact = queryArtifactObservation(call, output);
  if (artifact) return artifact;
  const action = call?.input?.action, name = String(call?.name || '').replace(/^local\.delegation\./, '');
  if (['post_reply', 'wait_for_sessions'].includes(name)) return null;
  if (name === 'coordinate_work' && action === 'assess') {
    if (!output?.review?.passed) return null;
    return { kind: 'advanced', fact: { name, workId: output.receipt?.workId, review: { passed: true, sources: output.review.sources } } };
  }
  const failed = result?.ok === false || output?.ok === false || result?.success === false || ['failed', 'denied', 'cancelled'].includes(result?.status);
  const query = ['get_session', 'get_verification_detail'].includes(name) || name === 'coordinate_work' && action === 'query';
  // A requested ID is not proof that the host observed that object. Query/failure identity must come back in actual facts.
  const identified = failed || query ? output : call?.input;
  const subject = Object.fromEntries([...identity].filter(key => identified?.[key] !== undefined).map(key => [key, identified[key]]));
  if (failed) return { kind: 'observed', failure: true, fact: { name, action, subject,
    error: stableFailureClass(output?.error || result?.error || result?.code || result?.status || 'failed') } };
  // Recorded/queued communication is admission, never proof that execution happened.
  const applied = output?.executionEffect === 'applied' || output?.phase === 'completed' && output?.sessionId;
  return { kind: applied ? 'admitted' : 'observed', fact: { name, action, subject, result: output } };
}
export function normalizedProgressObservations(rounds = [], roster) {
  const rows = Array.isArray(roster) ? roster : roster?.items || roster?.sessions || [];
  const observations = rounds.flatMap(round => round.toolCalls || []).map(progressObservation).filter(Boolean);
  for (const row of rows) observations.push({ kind: ['accepted', 'completed'].includes(row.status) ? 'advanced' : 'observed',
    fact: { ...row, ...(['failed', 'waiting_agent', 'blocked_system'].includes(row.status) ? { summary: undefined, latestEvent: undefined } : {}) } });
  return [...new Map(observations.map(row => {
    const normalized = normalizeProgressMaterial(row.fact), fingerprint = digest(normalized);
    return [fingerprint, { kind: row.kind, failure: row.failure === true, fingerprint, fact: normalized }];
  })).values()];
}
export const stableOperationFailureKey = ({ workId, goalRevision, action, sessionId, error }) => digest({ workId, goalRevision, action,
  sessionId: sessionId || null, cause: stableFailureClass(error) });
