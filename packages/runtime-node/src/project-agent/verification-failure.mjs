const terminal = /^(verifier_(timeout|cancelled|permission_denied|budget_limited|checkpoint_unavailable|no_progress|report_invalid|in_progress)|verification_(source_changed|model_changed)|work_budget_limited|work_execution_stopped|execution_outcome_unknown)$/;

/** Keep useful diagnostics without exposing arbitrary Provider payload objects. */
export function verificationFailure(error) {
  const message = String(error?.message || error?.summary || error?.error || (typeof error === 'string' ? error : 'Verifier failed without a structured report')).slice(0, 1600);
  const raw = error?.code || error?.error || message;
  const code = terminal.test(raw) ? raw : error?.name === 'AbortError' ? 'verifier_cancelled'
    : /agent_loop_exhausted/.test(message) ? 'verifier_budget_limited' : 'verifier_failed';
  const nextAction = code === 'verifier_in_progress' ? 'wait_for_verification'
    : ['verifier_cancelled', 'work_execution_stopped'].includes(code) ? 'stopped'
    : code === 'verifier_permission_denied' ? 'resolve_permission'
    : /budget_limited/.test(code) ? 'review_budget'
    : code === 'execution_outcome_unknown' ? 'reconcile_execution'
    : /checkpoint|no_progress/.test(code) ? 'inspect_failure'
    : 'inspect_and_repair';
  return { ok: false, error: code, message, nextAction };
}
