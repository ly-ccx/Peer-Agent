const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_NOTES = 4;
const MAX_NOTE_CHARS = 240;

function clip(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_NOTE_CHARS) : '';
}

function notes(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clip).filter(Boolean))].slice(0, MAX_NOTES);
}

function fingerprint(feedback) {
  return JSON.stringify({
    scene: feedback.scene ?? 'application',
    artifactRef: feedback.artifactRef ?? '',
    findings: feedback.findings,
    repairSuggestions: feedback.repairSuggestions,
  });
}

const MECHANICAL_GAPS = new Set(['command', 'test', 'file', 'file-contains', 'file-exists']);
const HARD_GAPS = new Set([...MECHANICAL_GAPS, 'manual']);

function hasGap(unmet, kinds) {
  return unmet.some(item => kinds.has(item.kind) || kinds.has(item.reason));
}

/** Independent review must run whenever UI delivery is unmet and no mechanical
 * command/test/file gap remains. Pending manual confirmation is not a skip. */
export function needsIndependentVisualReview(gate) {
  const unmet = Array.isArray(gate?.unmet) ? gate.unmet : [];
  return unmet.some(item => item.kind === 'ui_delivery') && !hasGap(unmet, MECHANICAL_GAPS);
}

function uiOnlyGaps(gate) {
  const unmet = Array.isArray(gate?.unmet) ? gate.unmet : [];
  return unmet.some(item => item.kind === 'ui_delivery') && !hasGap(unmet, HARD_GAPS);
}

/** Host-only projection: never persist raw model text or image bytes. */
export function projectVisualRepairFeedback(report, gate) {
  if (report?.passed === true || !uiOnlyGaps(gate)) return null;
  const verdict = report?.verdict === 'inconclusive' ? 'inconclusive' : 'failed';
  const feedback = {
    verdict,
    scene: clip(report?.scene) || 'application',
    artifactRef: clip(report?.artifactRef),
    evidenceRef: clip(Array.isArray(report?.evidenceRefs) ? report.evidenceRefs[0] : report?.evidenceRef),
    findings: notes(report?.findings),
    repairSuggestions: notes(report?.repairSuggestions),
  };
  if (!feedback.findings.length) feedback.findings = notes((gate.unmet ?? []).map(item => item.reason));
  if (!feedback.artifactRef && !feedback.findings.length && !feedback.repairSuggestions.length) return null;
  return feedback;
}

export function normalizeVisualRepair(repair, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  if (repair === null) return undefined;
  if (!repair || typeof repair !== 'object') return undefined;
  const attempts = Number.isFinite(repair.attempts) ? Math.max(0, Math.trunc(repair.attempts)) : 0;
  const limit = Number.isFinite(repair.maxAttempts)
    ? Math.max(1, Math.trunc(repair.maxAttempts))
    : Math.max(1, Math.trunc(maxAttempts));
  const feedback = projectVisualRepairFeedback({
    passed: false,
    verdict: repair.feedback?.verdict,
    scene: repair.feedback?.scene,
    artifactRef: repair.feedback?.artifactRef,
    evidenceRef: repair.feedback?.evidenceRef,
    evidenceRefs: repair.feedback?.evidenceRef ? [repair.feedback.evidenceRef] : [],
    findings: repair.feedback?.findings,
    repairSuggestions: repair.feedback?.repairSuggestions,
  }, { unmet: [{ kind: 'ui_delivery' }] });
  if (!feedback) return undefined;
  const next = { attempts, maxAttempts: limit, feedback };
  if (typeof repair.lastFingerprint === 'string' && repair.lastFingerprint) next.lastFingerprint = repair.lastFingerprint;
  if (repair.pendingTurn === true) next.pendingTurn = true;
  return next;
}

export function describeVisualRepair(plan) {
  const repair = plan?.runner?.visualRepair;
  if (!repair?.feedback) return '';
  const remaining = Math.max(0, (repair.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) - (repair.attempts ?? 0));
  return [
    `Limited visual repair ${repair.attempts}/${repair.maxAttempts}; ${remaining} remaining.`,
    `Current scene ${repair.feedback.scene}; verdict ${repair.feedback.verdict}.`,
    repair.feedback.artifactRef ? `Re-observe artifact ${repair.feedback.artifactRef} after the fix.` : 'Re-observe the locked scene after the fix.',
    repair.feedback.findings.length ? `Visible issues: ${repair.feedback.findings.join('; ')}` : '',
    repair.feedback.repairSuggestions.length ? `Suggested fixes: ${repair.feedback.repairSuggestions.join('; ')}` : '',
    'Do not claim completion from this text. Capture a new screenshot of the same scene and wait for the local gate.',
  ].filter(Boolean).join(' ');
}

export function buildGoalRunnerTickMessage(plan, turnNumber) {
  const planLabel = plan?.title || plan?.goal || plan?.planId || 'goal';
  const repair = describeVisualRepair(plan);
  return `Goal Runner tick ${turnNumber} for goal "${planLabel}" (planId=${plan?.planId || 'unknown'}). Continue from the active GoalPlan state.${repair ? ` ${repair}` : ''}`;
}

export function scheduleVisualRepair(plan, report, gate, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  const feedback = projectVisualRepairFeedback(report ?? { passed: false }, gate);
  if (!feedback) return { kind: 'ineligible' };
  const current = normalizeVisualRepair(plan?.runner?.visualRepair, { maxAttempts })
    ?? { attempts: 0, maxAttempts, feedback };
  const mark = fingerprint(feedback);
  const attempts = current.attempts + 1;
  if (attempts > current.maxAttempts) {
    return {
      kind: 'exhausted',
      visualRepair: { ...current, attempts: current.maxAttempts, feedback, lastFingerprint: mark },
    };
  }
  return {
    kind: 'repair',
    visualRepair: { attempts, maxAttempts: current.maxAttempts, feedback, lastFingerprint: mark, pendingTurn: true },
  };
}
