import { createHash } from 'node:crypto';

/**
 * ADR 127 §5.8 / UO-07: no unknown claim may sit silently. This is a read-only
 * projection over device-ledger facts: it lists every protection-state claim with
 * its scope, age, owner and next action, plus the metrics release gates consume
 * (unknown rate, stale age). It creates no facts and gates nothing.
 */
export function unknownOutcomeDiagnostics({ resources, works = [], now = () => new Date().toISOString() } = {}) {
  if (!resources || typeof resources.snapshot !== 'function') throw new Error('diagnostics_host_unavailable');
  const at = now();
  const ageDays = updatedAt => {
    const parsed = Date.parse(updatedAt || '');
    return Number.isFinite(parsed) ? Math.max(0, (Date.parse(at) - parsed) / 86400000) : null;
  };
  const protectedClaims = resources.snapshot().filter(claim => ['draining', 'reconciling'].includes(claim.state));
  const worksByWorkspace = new Map(works.map(work => [work?.delegationOrigin?.workspaceId || work?.workspaceId || '', work]).filter(([, work]) => work));
  const claims = protectedClaims.map(claim => {
    const scope = claim.resourceRef.startsWith('directory:') ? { kind: 'directory', path: claim.resourceRef.slice('directory:'.length) }
      : claim.resourceRef.startsWith('file:') ? { kind: 'file', path: claim.resourceRef.slice('file:'.length) } : null;
    const unknownCalls = [...new Set(claim.evidenceCalls || [])];
    // A protection claim whose unknown dispatches carry no declared scope keeps the
    // conservative directory scope; the diagnostic names that explicitly (ADR §8.2).
    const budget = worksByWorkspace.get(claim.workspaceId)?.budget;
    const rows = [...(budget?.uncertainDispatches || []), ...Object.values(budget?.attempts || {}).flatMap(attempt => attempt.pendingTools || [])];
    const declared = unknownCalls.length > 0 && unknownCalls.every(id => Array.isArray(rows.find(row => row.toolCallId === id)?.declaredScopes));
    return {
      claimId: claim.claimId,
      workspaceId: claim.workspaceId,
      sessionId: claim.execution.sessionId,
      planId: claim.execution.planId,
      state: claim.state,
      scope: scope || { kind: 'unknown', ref: claim.resourceRef },
      ...(scope?.kind === 'directory' && !declared ? { scopeUnknown: true } : {}),
      unknownCalls,
      openHandles: Object.values(claim.handles || {}).filter(handle => handle.state !== 'ended').length,
      ageDays: ageDays(claim.updatedAt),
      nextAction: 'reconcile_execution_outcome',
    };
  });
  // Dispatch-level facts per work: settled receipts come from UO-02, uncertain rows are the live unknowns.
  const dispatch = works.map(work => {
    const budget = work?.budget || {};
    const receipts = Object.values(budget.dispatchReceipts || {});
    const unknown = [...(budget.uncertainDispatches || [])].length;
    const settled = receipts.length;
    return {
      workspaceId: work?.delegationOrigin?.workspaceId || work?.workspaceId || null,
      settled,
      unknown,
      settledByOutcome: receipts.reduce((counts, row) => { counts[row.outcome] = (counts[row.outcome] || 0) + 1; return counts; }, {}),
      unknownRate: settled + unknown > 0 ? unknown / (settled + unknown) : 0,
    };
  });
  const totals = {
    at,
    protectedClaims: claims.length,
    protectedClaimsByScope: claims.reduce((counts, claim) => { counts[claim.scope.kind] = (counts[claim.scope.kind] || 0) + 1; return counts; }, {}),
    scopeUnknownClaims: claims.filter(claim => claim.scopeUnknown).length,
    staleClaims: claims.filter(claim => claim.ageDays == null || claim.ageDays >= 7).length,
    worksWithUnknowns: dispatch.filter(row => row.unknown > 0).length,
    dispatchSettled: dispatch.reduce((sum, row) => sum + row.settled, 0),
    dispatchUnknown: dispatch.reduce((sum, row) => sum + row.unknown, 0),
  };
  totals.dispatchUnknownRate = totals.dispatchSettled + totals.dispatchUnknown > 0
    ? totals.dispatchUnknown / (totals.dispatchSettled + totals.dispatchUnknown) : 0;
  return { claims, dispatch, totals };
}

/** Digest for release-gate comparisons: same facts, same digest. */
export function diagnosticsDigest(report) {
  return `diagnostics-${createHash('sha256').update(JSON.stringify({ claims: report?.claims, totals: report?.totals })).digest('hex').slice(0, 32)}`;
}
