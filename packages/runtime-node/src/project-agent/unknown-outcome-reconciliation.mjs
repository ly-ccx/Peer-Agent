import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { createGitRead } from '../git-read.mjs';
import { proveRecorder } from './execution-recorder.mjs';
import { workBudgetBinding } from './work-budget.mjs';

/**
 * ADR 127 §5.3: bounded, read-only, host-executed probes over one unknown-outcome claim.
 * A verdict can end occupancy at most; it never turns an unknown call into a success.
 * The model may request and explain this evidence; it can never write it.
 */
export function createUnknownOutcomeReconciler({
  resources,
  gitStatus = createGitRead({ timeoutMs: 10_000, maxBytes: 256 * 1024 }),
  recorderIdentity = null,
  readWork = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!resources || typeof resources.claimsFor !== 'function' || typeof resources.recordReconciliation !== 'function') {
    throw new Error('reconciliation_host_unavailable');
  }
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  function workFacts(plan) {
    if (typeof readWork === 'function') return readWork(plan);
    const origin = plan?.delegationOrigin;
    const binding = origin?.workspaceId ? workBudgetBinding(origin.workspaceId) : null;
    if (!binding || typeof origin.workId !== 'string' || !origin.workId) return null;
    try {
      return typeof binding.store.readWork === 'function' ? binding.store.readWork(origin.workId)
        : binding.store.read().works[origin.workId];
    } catch { /* an unreadable budget leaves the dispatch receipts simply unobserved */ }
    return null;
  }
  return {
    async reconcile(plan, { claimId } = {}) {
      if (!plan?.delegationOrigin || typeof claimId !== 'string' || !claimId) return { ok: false, code: 'reconciliation_invalid_input' };
      const claim = resources.claimsFor(plan).find(row => row.claimId === claimId);
      if (!claim) return { ok: false, code: 'reconciliation_claim_missing' };
      if (!['draining', 'reconciling'].includes(claim.state)) return { ok: false, code: 'reconciliation_claim_active' };
      const unknownCalls = [...new Set(claim.evidenceCalls || [])];
      if (!unknownCalls.length) return { ok: false, code: 'reconciliation_no_unknown' };
      if (unknownCalls.length > 60) return { ok: false, code: 'reconciliation_too_many_unknown' };
      const probes = [];
      const push = (kind, ref, result) => probes.push({ kind, ref, result: JSON.stringify(result).slice(0, 4096),
        observedAt: now(), digest: digest({ kind, ref, result }) });

      // Receipt probe: UO-02 dispatch receipts answer a call without replaying it.
      const work = workFacts(plan), budget = work?.budget || {};
      const receipts = Object.values(budget.dispatchReceipts || {});
      const uncertain = [...(budget.uncertainDispatches || [])];
      const answered = new Map(), capabilityOf = new Map();
      for (const id of unknownCalls) {
        const row = uncertain.find(entry => entry.toolCallId === id);
        if (row?.capabilityId) capabilityOf.set(id, row.capabilityId);
        const receipt = receipts.find(entry => entry.toolCallId === id);
        if (receipt?.outcome) answered.set(id, receipt.outcome);
        push('receipt', `receipt:${id}`, { answered: receipt?.outcome || null,
          capabilityId: row?.capabilityId || null, dispatchId: row?.dispatchId || receipt?.dispatchId || null,
          registeredAt: row?.registeredAt || null });
      }
      // Handle probe: an open or unknown handle keeps the claim regardless of every other probe.
      const openHandles = Object.values(claim.handles || {})
        .filter(handle => handle.state !== 'ended').map(handle => handle.handleId || handle.toolCallId).filter(Boolean);
      push('handle', `handles:${claim.claimId}`, { openHandles });
      // Process probe: recorder death proof. `not_available` means nothing ever recorded a
      // recorder for this execution; `unproven` still blocks a conclusive verdict.
      const origin = plan.delegationOrigin;
      const binding = workBudgetBinding(origin.workspaceId);
      const control = binding?.store?.readSessionControl?.(origin.sessionId) || origin.executionControl;
      const identity = typeof recorderIdentity === 'function' ? recorderIdentity() : null;
      const recorderProof = control?.recorder && identity ? proveRecorder(control.recorder, identity) : 'not_available';
      push('process', `process:${origin.sessionId}`, { recorderProof });
      // Workspace probe: fenced git status over the claim's declared directory, untracked included.
      const directory = claim.resourceRef.startsWith('directory:') ? claim.resourceRef.slice('directory:'.length) : null;
      let clean = null, gitVisibleChanges = null;
      if (!directory) push('workspace', claim.resourceRef, { clean: null, error: 'scope_not_directory' });
      else {
        try {
          // The probe may only observe inside the claim's declared directory; a Git
          // directory outside it (worktrees) stays unobserved and therefore inconclusive.
          let scopeRoot = directory;
          try { scopeRoot = realpathSync(directory); } catch { /* probe on the raw path then */ }
          const observed = await gitStatus({ path: directory, operation: 'status' }, {
            authorize: async probed => {
              const base = scopeRoot.endsWith(path.sep) ? scopeRoot : `${scopeRoot}${path.sep}`;
              // Git's own enumerated configuration sources (system/global gitconfig) are
              // read-only fixed host paths; everything else must stay inside the claim scope.
              const configSource = /(^|\/)\.?gitconfig$|\/git\/config$/.test(probed);
              if (!configSource && probed !== directory && probed !== scopeRoot && !probed.startsWith(base)) {
                throw Object.assign(new Error('reconciliation_scope_exceeded'), { reason: 'reconciliation_scope_exceeded' });
              }
            },
          });
          const status = observed?.status;
          clean = status ? status.clean : null;
          // gitRead reports `clean: null` whenever any clean/process filter is configured, even
          // though it disables them and re-observes. The counted facts — with untracked included —
          // are the coverage statement (ADR 127 §5.5), so the verdict reads the counts, not the label.
          gitVisibleChanges = status ? (status.changed ?? 0) + (status.untracked ?? 0) > 0 : null;
          push('workspace', claim.resourceRef, { clean, changed: status?.changed ?? null, untracked: status?.untracked ?? null,
            consistent: observed?.consistent ?? null, paths: (status?.entries || []).slice(0, 32).map(entry => entry.path) });
        } catch (error) {
          push('workspace', claim.resourceRef, { clean: null, error: error?.reason || 'git_unavailable' });
        }
      }
      // Verdict is host-computed occupancy truth. Fencing must be proven, not assumed:
      // a call whose capability cannot be shown host-local stays unfenced.
      const fenced = unknownCalls.every(id => typeof capabilityOf.get(id) === 'string' && capabilityOf.get(id).startsWith('local.'));
      let verdict;
      if (!fenced) verdict = 'unfenced_external';
      else if (openHandles.length || recorderProof === 'alive' || recorderProof === 'unproven') verdict = 'inconclusive';
      else if (unknownCalls.every(id => answered.get(id) === 'not_dispatched')) verdict = 'no_effect_observed';
      else if (gitVisibleChanges === false) verdict = 'no_effect_observed';
      else verdict = 'inconclusive';
      const evidenceDigest = digest({ claimId: claim.claimId, claimRevision: claim.revision,
        resourceRef: claim.resourceRef, verdict, probes: probes.map(probe => probe.digest) });
      const evidence = { execution: claim.execution, claimId: claim.claimId, claimRevision: claim.revision,
        scope: claim.scope || (directory ? { kind: 'directory', path: directory } : undefined),
        probes, verdict, evidenceDigest };
      return { ok: true, evidence: resources.recordReconciliation(evidence) };
    },
  };
}
