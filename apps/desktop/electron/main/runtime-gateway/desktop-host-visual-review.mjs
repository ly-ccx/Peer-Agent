import { randomUUID } from 'node:crypto';
import { runPlanVisualVerifier } from './desktop-visual-review.mjs';

/** Host-owned independent review after an observation is recorded.
 * Chat and Goal share this path. A review is keyed by planId + artifactHash:
 * the same image is not reviewed twice; a newer image replaces an in-flight review;
 * each plan has at most one in-flight review. */
/** A superseded or disposed review is a cancellation, not a failure: only a verifier that
 * failed on its own must be reported, otherwise a replacement image would look like a defect.
 * Any other error is surfaced with a stable `visual-review-*` reason so the close gate can
 * release with something diagnosable instead of an always-empty judgment set. */
function failureReason(error, signal) {
  const message = typeof error?.message === 'string' ? error.message : '';
  // The watchdog aborts the verifier signal just before it reports, so a timeout has to be
  // classified ahead of the supersede check: an aborted signal normally means "cancelled, stay
  // silent", but a review that never settled is exactly the case that must not stay silent.
  if (error?.reviewTimeout === true) {
    return message.startsWith('visual-review-') ? message : 'visual-review-timeout';
  }
  // 索引迟到（即使超过等待窗口）也必须给出精确原因，能一眼看出是排序问题而不是画面缺陷。
  if (message === 'preview-artifact-unindexed') return 'visual-review-evidence-unindexed';
  if (signal?.aborted) return null;
  return message.startsWith('visual-review-') ? message : 'visual-review-host-error';
}

/** How long a host review may stay in flight before it counts as a failed review.
 * Sits above the verifier's own 120s in-flight abort (desktop-visual-review.mjs) so a merely
 * slow reply still reports through its normal path. This is the backstop for a verifier that
 * never settles at all, which would otherwise leave the close gate on an empty judgment set. */
export const REVIEW_TIMEOUT_MS = 150_000;

function reviewTimeoutError() {
  const error = new Error('visual-review-timeout');
  error.reviewTimeout = true;
  return error;
}

/** 宿主复核在 observe 工具调用内部就被调度，而工具结果要等该调用返回后才写入证据索引；
 * 账本在产物进入索引之前拒绝把它当作可复核证据（preview-artifact-unindexed）。这不是复核
 * 失败，只是一次排序竞争：索引随后就到。所以对它做有界等待，而不是把竞争记成复核失败。
 * 其他错误一律不重试，仍按下面的路径上报。 */
const INDEX_GRACE_ATTEMPTS = 8;
const INDEX_GRACE_MS = 40;

async function runVerifierWithIndexGrace(runVerifier, args, signal) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await runVerifier(args); } catch (error) {
      const unindexed = error?.message === 'preview-artifact-unindexed';
      if (!unindexed || attempt >= INDEX_GRACE_ATTEMPTS || signal?.aborted) throw error;
      await new Promise(resolve => setTimeout(resolve, INDEX_GRACE_MS));
    }
  }
}

export function createDesktopHostVisualReview({ runVerifier = runPlanVisualVerifier, now = Date.now } = {}) {
  const inflight = new Map();
  const reviewed = new Map();
  const failures = new Map();

  function schedule(plan, observation, context = {}) {
    if (!plan?.planId || !observation?.artifactHash) return { scheduled: false, reason: 'preview-review-identity-missing' };
    const reviewedHash = reviewed.get(plan.planId);
    if (reviewedHash === observation.artifactHash) return { scheduled: false, reason: 'preview-review-already-admitted' };
    const current = inflight.get(plan.planId);
    if (current?.artifactHash === observation.artifactHash) return { scheduled: false, reason: 'preview-review-in-flight' };
    current?.controller.abort();
    current?.promise.catch(() => {});
    if (current?.timer) clearTimeout(current.timer);
    const controller = new AbortController();
    const verifierRunId = `visual-verifier:${randomUUID()}`;
    const timeoutMs = Number.isFinite(context.timeoutMs) && context.timeoutMs > 0
      ? context.timeoutMs : REVIEW_TIMEOUT_MS;
    const work = {
      artifactHash: observation.artifactHash,
      artifactRef: observation.artifactRef,
      verifierRunId,
      controller,
      startedAt: now(),
      timer: null,
    };
    inflight.set(plan.planId, work);
    let started;
    try {
      started = runVerifierWithIndexGrace(runVerifier, {
        plan, verifierRunId, signal: controller.signal,
        goalPlanStore: context.goalPlanStore, workspacePath: context.workspacePath,
        llmChatService: context.llmChatService, modelProviderId: context.modelProviderId,
      }, controller.signal);
    } catch (error) {
      started = Promise.reject(error);
    }
    // Bounded watchdog. The verifier gets its own chance to report first (it aborts itself at
    // 120s); this only fires when nothing settles at all, so the review still lands as a
    // diagnosable failure instead of staying pending forever on an empty judgment set.
    const watchdog = new Promise((_, reject) => {
      work.timer = setTimeout(() => {
        try { controller.abort(); } catch { /* best-effort */ }
        reject(reviewTimeoutError());
      }, timeoutMs);
    });
    work.promise = Promise.race([started, watchdog]).then((report) => {
      if (work.timer) clearTimeout(work.timer);
      if (inflight.get(plan.planId) === work) {
        inflight.delete(plan.planId);
        if (report?.passed === true) reviewed.set(plan.planId, observation.artifactHash);
      }
      return report;
    }, (error) => {
      if (work.timer) clearTimeout(work.timer);
      if (inflight.get(plan.planId) === work) inflight.delete(plan.planId);
      const reason = failureReason(error, controller.signal);
      if (reason) {
        failures.set(plan.planId, { reason, message: error?.message ?? String(error), at: now() });
        // Reporting is best-effort and must never replace the rejection contract below.
        try { context.onFailure?.(plan.planId, reason, error); } catch { /* best-effort */ }
      }
      throw error;
    });
    // The returned promise keeps rejecting (a caller may await it), but it must not become a
    // process-level unhandled rejection when nobody watches the background review.
    work.promise.catch(() => {});
    return { scheduled: true, verifierRunId, promise: work.promise };
  }

  function inflightFor(planId) { return inflight.get(planId) ?? null; }
  function reviewedHashFor(planId) { return reviewed.get(planId) ?? null; }
  function lastFailureFor(planId) { return failures.get(planId) ?? null; }
  function dispose() {
    for (const work of inflight.values()) {
      if (work.timer) clearTimeout(work.timer);
      work.controller.abort();
      work.promise?.catch(() => {});
    }
    inflight.clear();
  }

  return { schedule, inflightFor, reviewedHashFor, lastFailureFor, dispose };
}
