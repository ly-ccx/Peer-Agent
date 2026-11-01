/** Host-issued control and resource facts. None of these receipts grants tool permission. */
export interface ExecutionResourceScope { readonly kind: 'directory'; readonly path: string }
export interface SessionExecutionIdentity {
  readonly planId: string;
  readonly sessionId: string;
  readonly executionEpoch: string;
  readonly goalRevision?: number;
  readonly generation?: string;
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
  | { readonly kind: 'protection'; readonly nextAction?: 'reconcile_execution_outcome' | 'confirm_execution_stopped'; readonly code: 'execution_outcome_unknown' | 'execution_stop_unconfirmed'; readonly resourceRef: string; readonly claimId: string; readonly sessionId?: string; readonly operationId?: string; readonly evidenceCalls: readonly string[] }
  | { readonly kind: 'recovery'; readonly nextAction?: 'inspect_resource_recovery'; readonly code: string; readonly resourceRef?: string };
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
}

/** Feed the existing lifecycle projector; a stale compatibility mirror cannot revive an old stop. */
export function controlPhasesForOrigin(origin: {
  readonly executionControl?: SessionControlOperation;
  readonly cancellation?: { readonly phase: string };
  readonly takeover?: { readonly phase: string };
}): { cancellationPhase?: string; takeoverPhase?: string } {
  const control = origin.executionControl;
  if (!control) return { cancellationPhase: origin.cancellation?.phase, takeoverPhase: origin.takeover?.phase };
  const stopping = control.phase === 'reconciling' && control.stopReceipt?.unknownCalls.length ? 'awaiting_outcome' : 'stopping';
  return {
    cancellationPhase: control.kind === 'cancel'
      ? control.phase === 'settled' && control.outcome === 'applied' ? 'completed' : stopping
      : origin.cancellation?.phase,
    takeoverPhase: control.phase === 'settled' && control.stopReceipt ? undefined
      : control.kind === 'takeover' ? stopping : origin.takeover?.phase,
  };
}
