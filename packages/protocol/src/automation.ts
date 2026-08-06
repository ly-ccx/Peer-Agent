import type { Evidence } from './index.ts';

/** Stable lifecycle of a reusable automation definition. */
export type AutomationLifecycleStatus =
  | 'draft'
  | 'active'
  | 'paused'
  | 'completed'
  | 'disabled'
  | 'archived';

export type AutomationScheduleKind =
  | 'once'
  | 'hourly'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly'
  | 'custom_cron';

export type AutomationMissedRunPolicy = 'run_latest' | 'skip';
export type AutomationOverlapPolicy = 'skip' | 'queue_latest';
export type AutomationAccessPreset = 'observe' | 'work_in_workspace';
export type AutomationTriggerSource = 'scheduled' | 'manual' | 'retry';

export type AutomationRunStatus =
  | 'scheduled'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting_permission'
  | 'waiting_user'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'blocked';

export type AutomationRunBlockedReason =
  | 'workspace_missing'
  | 'workspace_not_git'
  | 'git_baseline_invalid'
  | 'provider_unavailable'
  | 'auth_expired'
  | 'capability_missing'
  | 'grant_invalid'
  | 'budget_exhausted_before_start'
  | 'runtime_unavailable';

export type AutomationRunSkippedReason =
  | 'overlap'
  | 'missed_policy'
  | 'automation_paused'
  | 'global_pause';

export interface AutomationSchedule {
  readonly kind: AutomationScheduleKind;
  /** IANA timezone such as Asia/Shanghai. */
  readonly timezone: string;
  /** ISO timestamp for a one-time schedule. */
  readonly onceAt?: string;
  /** Positive interval for hourly schedules. */
  readonly everyHours?: number;
  /** Local wall-clock hour in the saved timezone. */
  readonly hour?: number;
  /** Local wall-clock minute in the saved timezone. */
  readonly minute?: number;
  /** ISO weekday values: Monday=1 ... Sunday=7. */
  readonly weekdays?: readonly number[];
  /** Day of month, 1...31. */
  readonly dayOfMonth?: number;
  /** Five-field, minute-level cron expression. */
  readonly cron?: string;
}

export interface AutomationGrant {
  readonly preset: AutomationAccessPreset;
  readonly workspacePath: string;
  readonly allowedCapabilityIds: readonly string[];
  readonly askCapabilityIds: readonly string[];
  readonly blockedCapabilityIds: readonly string[];
  readonly confirmedAt: string;
  readonly version: number;
}

export interface AutomationNotificationPolicy {
  readonly needsAttention: 'system_and_badge' | 'badge_only';
  readonly failed: boolean;
  readonly succeeded: boolean;
}

export interface AutomationBudget {
  readonly timeoutMs: number;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
  readonly maxRunsPerDay?: number;
}

export interface AutomationDefinition {
  readonly automationId: string;
  readonly version: number;
  readonly name: string;
  readonly prompt: string;
  readonly workspacePath: string;
  readonly modelProviderId?: string | null;
  readonly schedule: AutomationSchedule;
  readonly grant: AutomationGrant;
  readonly notifications: AutomationNotificationPolicy;
  readonly budget: AutomationBudget;
  readonly missedRunPolicy: AutomationMissedRunPolicy;
  readonly overlapPolicy: AutomationOverlapPolicy;
  readonly status: AutomationLifecycleStatus;
  readonly pauseReason?: 'user' | 'global' | 'consecutive_failures' | 'configuration_invalid';
  readonly consecutiveFailures: number;
  readonly lastScheduledAt?: string;
  readonly lastRunAt?: string;
  readonly nextRunAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Immutable definition/runtime facts captured when a run is created. */
export interface AutomationRunSnapshot {
  readonly definitionVersion: number;
  readonly name: string;
  readonly prompt: string;
  readonly workspacePath: string;
  readonly modelProviderId?: string | null;
  readonly schedule: AutomationSchedule;
  readonly grant: AutomationGrant;
  readonly budget: AutomationBudget;
  readonly gitBaseline?: {
    readonly commit: string;
    readonly branch?: string;
    readonly dirty: boolean;
  };
}

export interface AutomationRunVerification {
  readonly command: string;
  readonly status: 'passed' | 'failed';
  readonly exitCode?: number;
  readonly summary?: string;
  readonly evidenceRefs: readonly string[];
}

export interface AutomationRunChangeSet {
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly changedFiles: readonly string[];
  readonly additions?: number;
  readonly deletions?: number;
  readonly diffArtifactRefs: readonly string[];
  readonly retained: boolean;
}

export interface AutomationRunReceipt {
  readonly summary?: string;
  readonly error?: string;
  readonly evidence: readonly Evidence[];
  readonly evidenceRefs: readonly string[];
  readonly verifications: readonly AutomationRunVerification[];
  readonly changes?: AutomationRunChangeSet;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly durationMs?: number;
  readonly completedAt: string;
}

export interface AutomationRun {
  readonly runId: string;
  readonly automationId: string;
  readonly sourceRunId?: string;
  readonly idempotencyKey: string;
  readonly triggerSource: AutomationTriggerSource;
  readonly status: AutomationRunStatus;
  readonly scheduledAt: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly conversationId?: number;
  readonly missedRecovery?: boolean;
  readonly blockedReason?: AutomationRunBlockedReason;
  readonly skippedReason?: AutomationRunSkippedReason;
  readonly failureReason?: string;
  readonly attentionVersion: number;
  readonly snapshot: AutomationRunSnapshot;
  readonly receipt?: AutomationRunReceipt;
}

export interface AutomationRuntimeState {
  readonly globallyPaused: boolean;
  readonly pausedAt?: string;
  readonly activeRunIds: readonly string[];
  readonly updatedAt: string;
}

export interface AutomationSummary {
  readonly definition: AutomationDefinition;
  readonly latestRun?: AutomationRun;
  readonly activeRun?: AutomationRun;
  readonly needsAttention: boolean;
}

export interface AutomationCreateInput {
  readonly name: string;
  readonly prompt: string;
  readonly workspacePath: string;
  readonly modelProviderId?: string | null;
  readonly schedule: AutomationSchedule;
  readonly grant: AutomationGrant;
  readonly notifications: AutomationNotificationPolicy;
  readonly budget: AutomationBudget;
  readonly missedRunPolicy?: AutomationMissedRunPolicy;
  readonly overlapPolicy?: AutomationOverlapPolicy;
  readonly enable: boolean;
}

export interface AutomationUpdateInput {
  readonly automationId: string;
  readonly expectedVersion: number;
  readonly patch: Partial<Omit<AutomationCreateInput, 'enable'>> & {
    readonly status?: AutomationLifecycleStatus;
  };
}

export interface AutomationListInput {
  readonly workspacePath?: string;
  readonly statuses?: readonly AutomationLifecycleStatus[];
  readonly query?: string;
}

export interface AutomationRunListInput {
  readonly automationId: string;
  readonly statuses?: readonly AutomationRunStatus[];
  readonly limit?: number;
  readonly before?: string;
}

export interface AutomationRunNowInput {
  readonly automationId: string;
}

export interface AutomationRetryRunInput {
  readonly runId: string;
}

export interface AutomationCancelRunInput {
  readonly runId: string;
}

export interface AutomationPermissionDecisionInput {
  readonly runId: string;
  readonly toolCallId: string;
  readonly decision: 'allow_once' | 'deny';
}

export interface AutomationRuntimeCommandInput {
  readonly paused: boolean;
}

export type AutomationEvent =
  | { readonly type: 'definition_changed'; readonly automationId: string }
  | { readonly type: 'run_changed'; readonly automationId: string; readonly runId: string }
  | { readonly type: 'attention_changed'; readonly automationId: string; readonly runId: string; readonly attentionVersion: number }
  | { readonly type: 'runtime_changed'; readonly state: AutomationRuntimeState };

export interface AutomationBootstrapResult {
  readonly automations: readonly AutomationSummary[];
  readonly runtime: AutomationRuntimeState;
}

/** How a conversation entered automation-task creation. */
export type AutomationCreateContextSource = 'automation_center' | 'chat_intent';

/** Conversation-scoped state; persisted with conversation metadata across restarts. */
export type AutomationCreateContextStatus =
  | 'collecting'
  | 'proposed'
  | 'creating'
  | 'created'
  | 'cancelled'
  | 'failed';

export type AutomationProposalStatus =
  | 'proposed'
  | 'creating'
  | 'created'
  | 'cancelled'
  | 'failed';

export type AutomationProposalConfidence = 'high' | 'medium';

/**
 * Structured proposal emitted by the governed local automation capability.
 * `definition` reuses the existing create contract; this is not a second automation definition.
 */
export interface AutomationChatProposal {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly conversationId: string;
  readonly fingerprint: string;
  readonly source: AutomationCreateContextSource;
  readonly confidence: AutomationProposalConfidence;
  readonly status: AutomationProposalStatus;
  readonly definition: AutomationCreateInput;
  readonly replacesProposalId?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly automationId?: string | null;
  readonly receipt?: AutomationCreationReceipt | null;
  readonly error?: string | null;
}

/** Single conversation source of truth while a task is being collected or proposed. */
export interface AutomationCreateContext {
  readonly schemaVersion: 1;
  readonly kind: 'automation_create';
  readonly source: AutomationCreateContextSource;
  readonly status: AutomationCreateContextStatus;
  readonly activeProposal?: AutomationChatProposal | null;
  readonly rejectedFingerprints: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AutomationProposalAction = 'confirm' | 'cancel';

export interface AutomationProposalActionRequest {
  readonly conversationId: string;
  readonly proposalId: string;
  readonly fingerprint: string;
  readonly action: AutomationProposalAction;
}

/** Receipt is derived from a real created Automation Definition, never assistant text. */
export interface AutomationCreationReceipt {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly fingerprint: string;
  readonly conversationId: string;
  readonly automationId: string;
  readonly automationName: string;
  readonly definitionVersion: number;
  readonly lifecycleStatus: AutomationLifecycleStatus;
  readonly createdAt: string;
  readonly nextRunAt?: string | null;
}

export interface AutomationProposalActionResult {
  readonly proposal: AutomationChatProposal;
  readonly receipt?: AutomationCreationReceipt | null;
  readonly replayed: boolean;
}

/**
 * Durable conversation origin for automation Fresh Runs.
 * Distinct from AutomationCreateContext (chat → create automation draft).
 * UI badges and audit links must read this field, not title prefixes.
 */
export type ConversationAutomationOriginKind = 'automation_run';

export interface ConversationAutomationOrigin {
  readonly kind: ConversationAutomationOriginKind;
  readonly automationId: string;
  readonly runId: string;
  readonly automationName: string;
  readonly triggerSource: AutomationTriggerSource;
  readonly createdAt: string;
}
