/**
 * Verification verdict for a finished work session.
 * The gate sees only the host evidence index and host UI-delivery authority.
 * A model sentence on the plan, and runner.verifierRuns, are not inputs.
 */

import { evaluateVerificationGate } from '../goal-runner.mjs';

function asEvidenceIndex(evidenceIndex) {
  if (evidenceIndex instanceof Set) return evidenceIndex;
  if (!evidenceIndex) return new Set();
  return new Set(evidenceIndex);
}

function countLeaves(plan) {
  let leaves = 0;
  const visit = (tasks) => {
    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (!task || typeof task !== 'object') continue;
      const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
      if (subtasks.length > 0) {
        visit(subtasks);
        continue;
      }
      leaves += 1;
    }
  };
  visit(plan?.tasks);
  return leaves;
}

function unmetLeafCount(gate) {
  const ids = new Set();
  let anonymous = 0;
  for (const item of gate?.unmet ?? []) {
    if (item?.kind !== 'task') continue;
    if (typeof item.taskId === 'string' && item.taskId) ids.add(item.taskId);
    else anonymous += 1;
  }
  return ids.size + anonymous;
}

function collectPlanEvidenceRefs(plan) {
  const refs = [];
  const visit = (tasks) => {
    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (!task || typeof task !== 'object') continue;
      for (const ref of Array.isArray(task.evidenceRefs) ? task.evidenceRefs : []) {
        if (typeof ref === 'string' && ref.trim()) refs.push(ref.trim());
      }
      visit(task.subtasks);
    }
  };
  visit(plan?.tasks);
  return refs;
}

function intersectEvidence(plan, index) {
  const seen = new Set();
  const refs = [];
  for (const ref of collectPlanEvidenceRefs(plan)) {
    if (!index.has(ref) || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

function checksFor(gate, independentVerifier) {
  const checks = [];
  if (gate?.reason === 'no_leaf_tasks') {
    checks.push({ name: 'leaves', passed: false, reason: 'no_leaf_tasks' });
  } else {
    const taskUnmet = (gate?.unmet ?? []).filter((item) => item?.kind === 'task');
    checks.push({
      name: 'leaf_evidence',
      passed: taskUnmet.length === 0,
      ...(taskUnmet[0]?.reason ? { reason: String(taskUnmet[0].reason) } : {}),
    });
  }
  checks.push({
    name: 'independent_verifier',
    passed: independentVerifier === 'passed' || independentVerifier === 'not_required',
    ...(independentVerifier === 'failed' || independentVerifier === 'missing'
      ? { reason: independentVerifier }
      : {}),
  });
  return checks;
}

/**
 * @param {object} plan
 * @param {Iterable<string> | null | undefined} evidenceIndex
 * @param {{
 *   independentVerifier?: 'passed' | 'failed' | 'not_required' | 'missing',
 *   verifierModel?: string,
 *   sameFamilyAsWorker?: boolean,
 *   uiDeliveryRequired?: boolean,
 *   uiDelivery?: object,
 * }} [hostAuthority]
 */
export function computeVerificationVerdict(plan, evidenceIndex, hostAuthority = {}) {
  const index = asEvidenceIndex(evidenceIndex);
  const authority = hostAuthority ?? {};
  const gate = evaluateVerificationGate(plan, {
    indexedEvidenceRefs: index,
    ...(authority.uiDeliveryRequired === true
      ? { uiDeliveryRequired: true, uiDelivery: authority.uiDelivery }
      : {}),
  });
  const independentVerifier = authority.independentVerifier ?? 'missing';
  const leaves = countLeaves(plan);
  let outcome = 'failed';
  if (leaves === 0 || gate?.reason === 'no_leaf_tasks') outcome = 'unverifiable';
  else if (independentVerifier === 'failed') outcome = 'failed';
  else if (gate?.passed === true) outcome = 'passed';
  else if (unmetLeafCount(gate) < leaves) outcome = 'partial';
  return {
    outcome,
    independentVerifier,
    ...(typeof authority.verifierModel === 'string' ? { verifierModel: authority.verifierModel } : {}),
    ...(typeof authority.sameFamilyAsWorker === 'boolean'
      ? { sameFamilyAsWorker: authority.sameFamilyAsWorker }
      : {}),
    checks: checksFor(gate, independentVerifier),
    evidenceRefs: intersectEvidence(plan, index),
  };
}
