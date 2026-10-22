import { computeVerificationVerdict } from './verification-verdict.mjs';

const OUTPUT_LIMIT = 2000;

/**
 * 结论、检查和输出摘要只来自宿主证据索引。
 * 计划上的模型自述、runner.verifierRuns 和调用方塞进来的 modelClaim 都不读。
 */
export function buildVerificationDetail(facts = {}) {
  const plan = facts.plan && typeof facts.plan === 'object' ? facts.plan : {};
  const evidenceIndex = facts.evidenceIndex instanceof Set || Array.isArray(facts.evidenceIndex)
    ? facts.evidenceIndex
    : [];
  const authority = {};
  if (typeof facts.independentVerifier === 'string') authority.independentVerifier = facts.independentVerifier;
  if (typeof facts.verifierModel === 'string') authority.verifierModel = facts.verifierModel;
  if (typeof facts.sameFamilyAsWorker === 'boolean') authority.sameFamilyAsWorker = facts.sameFamilyAsWorker;
  const verdict = computeVerificationVerdict(plan, evidenceIndex, authority);
  const allowed = new Set(verdict.evidenceRefs);
  const outputs = [];
  for (const item of Array.isArray(facts.outputs) ? facts.outputs : []) {
    const evidenceRef = typeof item?.evidenceRef === 'string' ? item.evidenceRef.trim() : '';
    if (!evidenceRef || !allowed.has(evidenceRef)) continue;
    const body = typeof item.text === 'string' ? item.text : '';
    const summary = Array.from(body).slice(0, OUTPUT_LIMIT).join('');
    outputs.push({
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'output',
      evidenceRef,
      summary,
      truncated: body.length > summary.length,
    });
  }
  return {
    sessionId: typeof facts.sessionId === 'string' ? facts.sessionId : '',
    outcome: verdict.outcome,
    checks: verdict.checks.map((check) => ({
      name: check.name,
      result: check.passed === true ? 'passed' : 'failed',
      evidenceRefs: verdict.evidenceRefs,
      ...(check.reason ? { reason: check.reason } : {}),
    })),
    workerModel: typeof facts.workerModel === 'string' ? facts.workerModel : null,
    verifierModel: typeof authority.verifierModel === 'string' ? authority.verifierModel : null,
    sameSource: facts.sameFamilyAsWorker === true,
    reviewAttempts: facts.reviewAttempts || [],
    outputs,
  };
}

