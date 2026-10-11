export const VERIFICATION_TIMEOUT_MS = 5 * 60_000;

export function isVerificationTurn(profile) {
  return ['verifier', 'visual_verifier'].includes(profile?.role)
    || profile?.role === 'work_session' && ['verifier', 'visual_verifier'].includes(profile.agentKind);
}

export function verificationExecutionBudget(budget = {}) {
  const cap = (value, limit) => Number.isFinite(value) && value >= 0 ? Math.min(value, limit) : limit;
  return { ...budget, maxTurns: cap(budget.maxTurns, 12), maxToolCalls: cap(budget.maxToolCalls, 128),
    maxToolBatchCalls: cap(budget.maxToolBatchCalls, 16) };
}

function failure(code, name, message) {
  return Object.assign(new Error(message), { code, name });
}

/**
 * Readonly reviewers may release their lease on abort without waiting for an unresponsive adapter.
 * @template T
 * @param {{ run: (signal: AbortSignal) => T | Promise<T>, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<T>}
 */
export function runBoundedVerification({ run, signal, timeoutMs = VERIFICATION_TIMEOUT_MS } = {}) {
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, VERIFICATION_TIMEOUT_MS) : VERIFICATION_TIMEOUT_MS;
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let finished = false, timer;
    const finish = (settle, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      settle(value);
    };
    const cancel = error => {
      finish(reject, error);
      controller.abort(error);
    };
    const abort = () => cancel(['verifier_timeout', 'verifier_permission_denied'].includes(signal?.reason?.code) ? signal.reason
      : failure('verifier_cancelled', 'AbortError', 'Verifier cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(() => cancel(failure('verifier_timeout', 'TimeoutError', 'Verifier exceeded its overall deadline')), deadline);
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return run(controller.signal);
    }).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
