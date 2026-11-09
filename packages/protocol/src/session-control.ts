/** Host-issued control and resource facts. None of these receipts grants tool permission. */
/** Dispatch-declared protection scopes (ADR 127). Only 'directory' is produced today; the narrower kinds arrive with claim scope convergence. */
export type ExecutionResourceScope =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'git_ref'; readonly ref: string }
  | { readonly kind: 'remote_object'; readonly ref: string };
export function normalizeExecutionResourceScope(raw: unknown): ExecutionResourceScope | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return;
  const value = raw as Record<string, unknown>;
  const scopePath = typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 2048 && !/[\u0000-\u001f]/.test(value.path);
  const scopeRef = typeof value.ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,511}$/.test(value.ref) && !value.ref.includes('..');
  if ((value.kind === 'directory' || value.kind === 'file') && scopePath && Object.keys(value).length === 2) return { kind: value.kind, path: value.path };
  if ((value.kind === 'git_ref' || value.kind === 'remote_object') && scopeRef && Object.keys(value).length === 2) return { kind: value.kind, ref: value.ref };
  return;
}
export interface SessionExecutionIdentity {
  readonly planId: string;
  readonly sessionId: string;
  readonly executionEpoch: string;
  readonly goalRevision?: number;
  readonly generation?: string;
}
/** Shape only; a host must still compare it with the current canonical plan. */
export function normalizeSessionExecutionIdentity(raw: unknown): SessionExecutionIdentity | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return;
  const value = raw as Record<string, unknown>;
  const token = (item: unknown): item is string => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(item) && !item.includes('..');
  if (Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) => !['planId', 'sessionId', 'executionEpoch', 'goalRevision', 'generation'].includes(key) || !('value' in descriptor))
    || !token(value.planId) || !token(value.sessionId) || typeof value.executionEpoch !== 'string' || !value.executionEpoch.length || value.executionEpoch.length > 512
    || /[\u0000-\u001f]/.test(value.executionEpoch) || value.generation !== undefined && !token(value.generation)
    || value.goalRevision !== undefined && (!Number.isSafeInteger(value.goalRevision) || Number(value.goalRevision) < 0)) return;
  return { planId: value.planId, sessionId: value.sessionId, executionEpoch: value.executionEpoch,
    ...(value.generation !== undefined ? { generation: value.generation } : {}), ...(value.goalRevision !== undefined ? { goalRevision: Number(value.goalRevision) } : {}) };
}
export interface StopBarrierReceipt {
  readonly receiptId: string;
  readonly operationId: string;
  readonly execution: SessionExecutionIdentity;
  readonly admissionClosed: true;
  readonly runnerIdle: true;
  readonly schedulerIdle: true;
  readonly resourceClaims: readonly { readonly claimId: string; readonly revision: number }[];
  readonly unknownCalls: readonly string[];
  readonly completedAt: string;
  readonly scope: 'managed_execution';
}
export interface SessionControlOperation {
  readonly operationId: string;
  readonly requestDigest: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly parentConversationId: string;
  readonly sessionId: string;
  readonly planId: string;
  readonly kind: 'pause' | 'cancel' | 'takeover' | 'resume';
  readonly authorityRef: string;
  readonly hostEpoch?: string;
  /** Pid of the process that recorded the operation. By itself this is not a death proof. */
  readonly hostPid?: number;
  readonly recorder?: { readonly bootId: string; readonly pid: number; readonly pidStart: string; readonly hostId: string; readonly acquiredAt: string };
  readonly unproven?: boolean;
  readonly recoveryFactsDigest?: string;
  readonly priorStopReceiptId?: string;
  readonly expectedExecution: SessionExecutionIdentity;
  readonly phase: 'recorded' | 'draining' | 'reconciling' | 'settled';
  readonly outcome?: 'applied' | 'superseded' | 'rejected';
  readonly supersededBy?: string;
  readonly nextAction?: string;
  readonly stopReceipt?: StopBarrierReceipt;
  readonly updatedAt: string;
}
export type ExecutionResourceBlocker =
  | { readonly kind: 'owner'; readonly code: 'resource_busy'; readonly resourceRef: string; readonly claimId: string; readonly sessionId: string; readonly title: string }
  | { readonly kind: 'protection'; readonly nextAction?: 'reconcile_execution_outcome' | 'confirm_execution_stopped' | 'close_execution_claim'; readonly code: 'execution_outcome_unknown' | 'execution_stop_unconfirmed'; readonly resourceRef: string; readonly claimId: string; readonly sessionId?: string; readonly operationId?: string; readonly evidenceCalls: readonly string[]; readonly closeClaimAvailable?: boolean; readonly scope?: ExecutionResourceScope; readonly unknownOutcomePolicy?: UnknownOutcomePolicyTier; readonly reconciliationAvailable?: boolean; readonly resolutionTier?: UnknownOutcomeResolutionTier }
  | { readonly kind: 'recovery'; readonly nextAction?: 'inspect_resource_recovery'; readonly code: string; readonly resourceRef?: string };
/** A user-authorized end to one resource claim. It is not a stop receipt or a tool result. */
export interface ExecutionClaimClosure {
  readonly closureId: string;
  readonly claimId: string;
  readonly claimRevision: number;
  readonly execution: SessionExecutionIdentity;
  readonly resourceRef: string;
  readonly unknownCalls: readonly string[];
  readonly authorityRef: string;
  readonly proof: 'verified_dead' | 'legacy_user_confirmed';
  readonly scope: 'managed_execution';
  readonly at: string;
}
/** ADR 127: user-delegated closure policy for unknown outcomes. Bound to the bot subject (ADR 101); the model reads it but can never write it. */
export type UnknownOutcomePolicyTier = 'ask' | 'bot_verified';
export interface UnknownOutcomePolicy {
  readonly workspaceId: string;
  readonly agentConversationId: string;
  readonly tier: UnknownOutcomePolicyTier;
  readonly policyId: string;
  readonly revision: number;
  readonly delegatedAt?: string;
  readonly updatedAt: string;
}
export type ReconciliationVerdict = 'no_effect_observed' | 'effect_observed' | 'inconclusive' | 'unfenced_external';
export type ReconciliationProbeKind = 'process' | 'handle' | 'workspace' | 'git' | 'receipt';
export interface ReconciliationProbe { readonly kind: ReconciliationProbeKind; readonly ref: string; readonly result: string; readonly observedAt: string; readonly digest: string }
/** Host-computed probe bundle. Its verdict can end occupancy at most; it never turns an unknown call into a success. */
export interface ReconciliationEvidence {
  readonly execution: SessionExecutionIdentity;
  readonly claimId: string;
  readonly claimRevision: number;
  readonly scope: ExecutionResourceScope;
  readonly probes: readonly ReconciliationProbe[];
  readonly verdict: ReconciliationVerdict;
  readonly evidenceDigest: string;
}
export type UnknownOutcomeResolutionTier = 'user_confirmed' | 'bot_verified';
/** Ends occupancy for one claim (ADR 127). Unknown calls stay retained; this is not a tool result, a stop receipt or a success claim. */
export interface UnknownOutcomeResolution {
  readonly resolutionId: string;
  readonly claimId: string;
  readonly claimRevision: number;
  readonly execution: SessionExecutionIdentity;
  readonly scope: ExecutionResourceScope;
  readonly verdict: ReconciliationVerdict;
  readonly evidenceDigest: string;
  readonly tier: UnknownOutcomeResolutionTier;
  readonly policyRef?: string;
  readonly authorityRef: string;
  readonly unknownCalls: readonly string[];
  readonly at: string;
}
export interface ExecutionResourceClaim {
  readonly claimId: string;
  readonly resourceRef: string;
  readonly execution: SessionExecutionIdentity;
  readonly workspaceId: string;
  readonly hostEpoch: string;
  readonly state: 'reserved' | 'active' | 'draining' | 'reconciling' | 'released';
  readonly revision: number;
  readonly handles?: Readonly<Record<string, { readonly handleId: string; readonly toolCallId: string; readonly state: 'active' | 'ended' | 'unknown'; readonly completedAt?: string }>>;
  readonly evidenceCalls: readonly string[];
  /** Absent means the legacy directory scope derived from resourceRef; dispatch-declared scopes arrive with claim scope convergence. */
  readonly scope?: ExecutionResourceScope;
}

/** Feed the existing lifecycle projector; a stale compatibility mirror cannot revive an old stop. */
export function controlPhasesForOrigin(origin: {
  readonly executionControl?: SessionControlOperation;
  readonly cancellation?: { readonly phase: string };
  readonly takeover?: { readonly phase: string };
}): { cancellationPhase?: string; takeoverPhase?: string } {
  const control = origin.executionControl;
  if (!control) return { cancellationPhase: origin.cancellation?.phase, takeoverPhase: origin.takeover?.phase };
  // A barrier that has already recorded why it cannot confirm the stop is not still stopping.
  // Draining remains the in-progress label. This does not turn the refusal into a completed stop.
  const refused = control.phase === 'reconciling' && (
    Boolean(control.stopReceipt?.unknownCalls.length)
    || control.nextAction === 'execution_stop_unconfirmed'
    || control.nextAction === 'execution_outcome_unknown'
    || control.nextAction === 'reconcile_execution_outcome'
  );
  const stopping = refused ? 'awaiting_outcome' : 'stopping';
  return {
    cancellationPhase: control.kind === 'cancel'
      ? control.phase === 'settled' && control.outcome === 'applied' ? 'completed' : stopping
      : origin.cancellation?.phase,
    takeoverPhase: control.phase === 'settled' && control.stopReceipt ? undefined
      : control.kind === 'takeover' ? stopping : origin.takeover?.phase,
  };
}
