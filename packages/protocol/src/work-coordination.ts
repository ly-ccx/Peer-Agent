import type { ProjectRecoveryFailureKind } from './project-agent-failure.ts';

export interface ProjectWorkBudgetLimits {
  readonly schemaVersion?: 2;
  readonly source: string;
  readonly maxModelRequests?: number;
  readonly maxToolCalls?: number;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
}
export interface ProjectWorkBudgetBoundary {
  readonly metric: 'modelRequests' | 'toolCalls' | 'tokens' | 'costUsd';
  readonly used: number | null;
  readonly limit: number;
  readonly source: string;
  readonly reason: 'limit_reached' | 'usage_unknown' | 'reservation_pending';
}
/** Current host admission; a card action never grants execution authority. */
export interface ProjectReplyRecoveryAction {
  readonly canContinue: boolean;
  readonly blockedReason?: string;
  readonly budget?: ProjectWorkBudgetBoundary;
}

/** A reply attempt and delegated execution have independent outcomes. Host facts only. */
export interface ProjectReplyFailureStatus {
  readonly phase: 'current' | 'retrying' | 'superseded' | 'recovered' | 'cancelled' | 'paused';
  readonly turnKind: 'user' | 'wake';
  readonly workId?: string;
  readonly activeSessionIds: readonly string[];
  readonly recoveredByReplyId?: string;
}

/** Persisted on agent_turn.meta and the protected outcome; not a delivered reply. */
export interface ProjectAgentSilentWait {
  readonly source: 'host' | 'tool';
  readonly sessionIds: readonly string[];
}

/** Local host reservation; neither model text nor a UI timer owns recovery. */
export interface ProjectWorkRecovery {
  readonly failureKind: ProjectRecoveryFailureKind;
  readonly retryable: boolean;
  readonly autoAttempts: number;
  readonly failedTurnId: string;
  readonly retryAt?: string;
  readonly reservationId?: string;
  readonly deadlineAt?: string;
  readonly dispatchesReconciled?: boolean;
  readonly blockedCode?: 'RECOVERY_CHECKPOINT_UNAVAILABLE';
}

export type ProjectWorkState = 'runnable' | 'waiting_children' | 'waiting_user' | 'retry_wait' | 'paused'
  | 'budget_limited' | 'blocked_system' | 'delivered' | 'cancelled' | 'coalesced';
export type ProjectTurnEnd = 'reply_committed' | 'awaiting_children' | 'yielded' | 'awaiting_user'
  | 'budget_limited' | 'provider_retryable' | 'no_progress' | 'user_stopped' | 'fatal' | 'coalesced';
/** Host reconciliation closes an interrupted review/query, never supplies its result or verdict. */
export interface VerificationDispatchReconciliation {
  readonly attemptId: string;
  readonly toolCallId: string;
  readonly capabilityId: 'verify_session' | 'local.delegation.verify_session'
    | 'get_session' | 'local.delegation.get_session' | 'get_verification_detail' | 'local.delegation.get_verification_detail';
  readonly sessionId: string;
  readonly planId: string;
  readonly sourceRevision: string;
  readonly outcome: 'verification_interrupted' | 'query_interrupted';
  readonly at: string;
}

export interface ProjectWorkReceipt {
  readonly schemaVersion: 1;
  readonly workId: string;
  readonly workspaceId: string;
  readonly parentConversationId: string;
  readonly anchorInputIds: readonly string[];
  readonly sessionIds: readonly string[];
  /** Current owned technical blockers; a public progress update does not discharge them. */
  readonly repairSessionIds?: readonly string[];
  readonly progressFacts?: readonly string[];
  readonly state: ProjectWorkState;
  readonly revision: number;
  readonly checkpointRef?: string;
  readonly nativeCheckpointRef?: string;
  /** Only duplicate background observations transfer custody; all history remains. */
  readonly continuationOwnerWorkId?: string;
  readonly reportedWait?: { readonly replyIds: readonly string[]; readonly waitingUser: boolean;
    readonly sessionStates: readonly { readonly sessionId: string; readonly status: string; readonly sourceRevision: string; readonly observationRevision?: string }[] };
  readonly recovery?: ProjectWorkRecovery;
  readonly end?: ProjectTurnEnd;
  readonly attemptId?: string;
  readonly pendingEventIds?: readonly string[];
  readonly waitFor: readonly { readonly kind: 'session' | 'approval' | 'question' | 'retry_timer'; readonly id: string }[];
  readonly consumedEventIds: readonly string[];
  readonly pendingResultRefs: readonly string[];
  readonly lastDeliveredFactKey?: string;
  readonly budgetRef?: string;
  readonly budget?: {
    readonly modelRequests: number; readonly toolCalls: number; readonly tokens: number; readonly costUsd: number;
    readonly unknownUsage: boolean; readonly unknownCost: boolean;
    readonly limits: ProjectWorkBudgetLimits;
    readonly policyMigration?: { readonly version: 2; readonly reason: 'legacy_system_default_removed';
      readonly previousLimits: ProjectWorkBudgetLimits; readonly at: string };
    readonly lastBoundary?: ProjectWorkBudgetBoundary;
    readonly attempts: Readonly<Record<string, { readonly role: string; readonly requests?: number; readonly modelProviderId?: string;
      readonly checkpointRef?: string;
      readonly pendingTools?: readonly { readonly toolCallId: string | null; readonly capabilityId: string | null; readonly verificationSessionId?: string }[] }>>;
    readonly reconciledDispatches?: readonly VerificationDispatchReconciliation[];
    readonly uncertainDispatches?: readonly { readonly attemptId: string; readonly role: string;
      readonly toolCallId: string | null; readonly capabilityId: string | null; readonly verificationSessionId?: string }[];
  };
  readonly stopScope: 'reply' | 'work';
  readonly updatedAt: string;
}
