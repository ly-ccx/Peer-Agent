export type ChatAccessLevel =
  | 'owner'
  | 'spectator'
  | 'superpower'
  | 'share'
  | 'denied'
  | string;

export interface ChatAccessCheckResult {
  readonly access: ChatAccessLevel;
  readonly ownerWorkId?: string;
  readonly code?: string;
  readonly aclApplyLink?: string;
}

export interface AuthBaseRecord {
  readonly aclKey?: string;
  readonly name?: string;
  readonly description?: string;
  readonly white?: string;
  readonly black?: string;
  readonly [key: string]: unknown;
}

export interface AuthBaseListData {
  readonly list?: readonly AuthBaseRecord[];
  readonly items?: readonly AuthBaseRecord[];
  readonly total?: number;
  readonly [key: string]: unknown;
}

export type AgentCronSessionStatus =
  | 'active'
  | 'paused'
  | 'waiting_prerequisite'
  | 'completed'
  | 'archived'
  | string;

export type AgentCronRunStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'cancelled'
  | string;

export interface AgentCronScheduleSummary {
  readonly scheduleId?: string;
  readonly status?: string;
  readonly triggerType?: 'cron' | 'interval' | 'once' | string;
  readonly cronExpr?: string | null;
  readonly intervalMs?: number | null;
  readonly onceRunAt?: string | null;
  readonly nextRunAt?: string | null;
  readonly version?: number;
  readonly [key: string]: unknown;
}

export interface AgentCronSessionRecord {
  readonly sessionId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly agentId?: number | string;
  readonly ownerWorkId?: string;
  readonly status?: AgentCronSessionStatus;
  readonly activeScheduleId?: string;
  readonly schedule?: AgentCronScheduleSummary | null;
  readonly latestRun?: AgentCronRunRecord | null;
  readonly runStats?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface AgentCronSessionListData {
  readonly items?: readonly AgentCronSessionRecord[];
  readonly list?: readonly AgentCronSessionRecord[];
  readonly total?: number;
  readonly limit?: number;
  readonly offset?: number;
  readonly [key: string]: unknown;
}

export interface AgentCronRunRecord {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly scheduleId?: string;
  readonly status?: AgentCronRunStatus;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly errorMsg?: string | null;
  readonly [key: string]: unknown;
}

export interface AgentCronRunListData {
  readonly items?: readonly AgentCronRunRecord[];
  readonly list?: readonly AgentCronRunRecord[];
  readonly total?: number;
  readonly limit?: number;
  readonly offset?: number;
  readonly [key: string]: unknown;
}

export interface RoundTableInjectResult {
  readonly entryUuid?: string;
  readonly turnUuid?: string;
  readonly [key: string]: unknown;
}

export interface RoundTableAbortResult {
  readonly entryUuid?: string;
  readonly [key: string]: unknown;
}

export interface RoundTableTranscriptData {
  readonly turnUuid: string;
  readonly conversationId?: number | null;
  readonly entries: readonly Record<string, unknown>[];
}

export type AgentMemoryPatchStatus =
  | 'draft'
  | 'shadow'
  | 'active'
  | 'review_required'
  | 'rejected'
  | 'expired';

export interface AgentMemoryPatchUpdateResult {
  readonly patchUuid?: string;
  readonly status?: AgentMemoryPatchStatus | string;
  readonly ok?: boolean;
  readonly [key: string]: unknown;
}
