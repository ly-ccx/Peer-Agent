import { executionIdentity } from './session-control-kernel.mjs';

/**
 * Capabilities whose effects are confined to workspace paths by their execution authority.
 * Anything else — shell (network-capable), delegation, goal spawning, interactive, MCP or an
 * unknown id — cannot have its effects bounded to the claim's directory, so a policy-delegated
 * closure may never release it (ADR 127 §5.5 review: push/PR stays a permanent manual gate).
 */
const CONFINED_CAPABILITIES = new Set(['local.file.read', 'local.file.list', 'local.file.search', 'local.file.write', 'local.file.edit']);
const SETTLED_RECORDER_PROOFS = new Set(['dead', 'reused', 'different_boot']);

/**
 * ADR 127 §5.4–§5.6: policy-delegated closure of unknown-outcome claims.
 * The authorization comes from the user-saved policy (UO-01), never from model arguments.
 * The model may request this; the host computes eligibility from reconciliation evidence
 * (UO-03) and issues the receipt. A closure ends occupancy; it never claims success.
 */
export function createUnknownOutcomeResolver({ resources, readPolicy = null, now = () => new Date().toISOString() } = {}) {
  if (!resources || typeof resources.claimsFor !== 'function' || typeof resources.closeClaim !== 'function'
    || typeof resources.reconciliationEvidenceFor !== 'function') throw new Error('resolution_host_unavailable');
  function policyFor(plan) {
    if (typeof readPolicy !== 'function') return null;
    const result = readPolicy(plan?.delegationOrigin?.workspaceId);
    return result && typeof result === 'object' && result.tier ? result : null;
  }
  function findClaim(plan, claimId) {
    if (!plan?.delegationOrigin || typeof claimId !== 'string' || !claimId) return { code: 'resolution_invalid_input' };
    const claim = resources.claimsFor(plan).find(row => row.claimId === claimId);
    if (!claim) return { code: 'resolution_claim_missing' };
    if (!['draining', 'reconciling'].includes(claim.state)) return { code: 'resolution_claim_active' };
    return { claim };
  }
  /** The §5.5 risk envelope, evaluated only from host-recorded facts. */
  function envelope(claim) {
    const unknownCalls = [...new Set(claim.evidenceCalls || [])];
    if (!unknownCalls.length) return { ok: false, code: 'no_unknown_calls' };
    if (Object.values(claim.handles || {}).some(handle => handle.state !== 'ended')) return { ok: false, code: 'open_handles' };
    const rows = resources.reconciliationEvidenceFor(claim.claimId);
    const evidence = rows.length ? rows[rows.length - 1] : null;
    if (!evidence) return { ok: false, code: 'reconciliation_missing' };
    // Evidence older than the current claim revision is void: the claim changed after the probes.
    if (evidence.claimRevision !== claim.revision) return { ok: false, code: 'reconciliation_stale' };
    if (!['no_effect_observed', 'effect_observed'].includes(evidence.verdict)) return { ok: false, code: `verdict_${evidence.verdict}` };
    const process = evidence.probes.find(probe => probe.kind === 'process');
    let recorderProof = null;
    if (process) { try { recorderProof = JSON.parse(process.result).recorderProof || null; } catch { /* unreadable facts are no proof */ } }
    if (!SETTLED_RECORDER_PROOFS.has(recorderProof)) return { ok: false, code: 'recorder_not_proven_dead' };
    for (const id of unknownCalls) {
      const probe = evidence.probes.find(row => row.kind === 'receipt' && row.ref === `receipt:${id}`);
      let capabilityId = null;
      if (probe) { try { capabilityId = JSON.parse(probe.result).capabilityId || null; } catch { /* unreadable facts are no proof */ } }
      if (!CONFINED_CAPABILITIES.has(capabilityId)) return { ok: false, code: 'capability_not_confined' };
    }
    return { ok: true, evidence, unknownCalls };
  }
  return {
    /** Read-only eligibility for task detail and ask cards: what the policy allows here, and why not. */
    inspect(plan, { claimId } = {}) {
      const found = findClaim(plan, claimId);
      if (!found.claim) return { ok: false, code: found.code };
      const policy = policyFor(plan), check = envelope(found.claim);
      return { ok: true, claimId, policyTier: policy?.tier || 'ask',
        policyId: policy?.policyId || null, policyRevision: policy?.revision ?? null,
        eligible: check.ok, ...(check.ok ? { verdict: check.evidence.verdict, evidenceDigest: check.evidence.evidenceDigest } : { reason: check.code }) };
    },
    /** The bot-verified gate. No card, no grant: the saved policy plus host evidence decide. */
    resolveBotVerified(plan, { claimId } = {}) {
      const found = findClaim(plan, claimId);
      if (!found.claim) return { ok: false, code: found.code };
      const policy = policyFor(plan);
      if (!policy || policy.tier !== 'bot_verified') return { ok: false, code: 'authorization_required' };
      const check = envelope(found.claim);
      if (!check.ok) return { ok: false, code: check.code };
      try {
        const closure = resources.closeClaim(plan, {
          claimId: found.claim.claimId, claimRevision: found.claim.revision,
          authorityRef: `policy:${policy.policyId}`,
          unknownCalls: check.unknownCalls, proof: 'verified_dead', at: now(),
          resolution: { tier: 'bot_verified', verdict: check.evidence.verdict,
            evidenceDigest: check.evidence.evidenceDigest, policyRef: `policy:${policy.policyId}` },
        });
        return { ok: true, closure, resolution: closure.resolution, execution: executionIdentity(plan) };
      } catch (error) {
        return { ok: false, code: error?.message || 'resolution_failed' };
      }
    },
  };
}
