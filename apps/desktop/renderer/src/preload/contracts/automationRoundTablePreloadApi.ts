import type {
  AgentCronRunListData,
  AgentCronSessionListData,
  AgentCronSessionRecord,
  AgentMemoryPatchStatus,
  AgentMemoryPatchUpdateResult,
  RoundTableAbortResult,
  RoundTableInjectResult,
  RoundTableTranscriptData,
} from '@zeus-atlas/protocol';
import type { PreloadResult } from './apiResponse';

export interface AutomationRoundTablePreloadApi {
  readonly listAgentCronSessions: (params: {
    agentId?: number | string;
    status?: string;
    limit?: number;
    offset?: number;
  }) => PreloadResult<AgentCronSessionListData>;
  readonly getAgentCronSessionDetail: (params: {
    sessionId?: string;
    recentRunLimit?: number;
  }) => PreloadResult<AgentCronSessionRecord>;
  readonly createAgentCronSession: (params: {
    agentId: number;
    title: string;
    description?: string;
    triggerType: 'cron' | 'interval' | 'once';
    cronExpr?: string;
    intervalMs?: number;
    onceRunAt?: string;
    timezone?: string;
    taskTemplateJson?: Record<string, unknown>;
    completionPolicyJson?: Record<string, unknown>;
    deliveryConfigJson?: Record<string, unknown>;
  }) => PreloadResult<unknown>;
  readonly updateAgentCronSession: (params: {
    sessionId: string;
    expectedVersion: number;
    title?: string;
    triggerType?: 'cron' | 'interval' | 'once';
    cronExpr?: string | null;
    intervalMs?: number | null;
    taskTemplateJson?: Record<string, unknown> | null;
    completionPolicyJson?: Record<string, unknown> | null;
    deliveryConfigJson?: Record<string, unknown> | null;
  }) => PreloadResult<unknown>;
  readonly pauseAgentCronSession: (params: {
    sessionId?: string;
  }) => PreloadResult<AgentCronSessionRecord>;
  readonly resumeAgentCronSession: (params: {
    sessionId?: string;
  }) => PreloadResult<AgentCronSessionRecord>;
  readonly completeAgentCronSession: (params: {
    sessionId?: string;
    reason?: string;
  }) => PreloadResult<AgentCronSessionRecord>;
  readonly recoverAgentCronSessionOpenRuns: (params: {
    sessionId?: string;
    reason?: string;
  }) => PreloadResult<unknown>;
  readonly listAgentCronRuns: (params: {
    sessionId?: string;
    scheduleId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) => PreloadResult<AgentCronRunListData>;
  readonly injectRoundTableTurn: (params: {
    turnUuid?: string;
    conversationId?: number;
    content?: string;
    source?: string;
    interruptHint?: 'pivot' | 'addition' | 'correction' | 'suggest_invite' | 'force_conclude';
  }) => PreloadResult<RoundTableInjectResult>;
  readonly abortRoundTableTurn: (params: { turnUuid: string }) => PreloadResult<RoundTableAbortResult>;
  readonly getRoundTableTranscript: (params: { turnUuid: string }) => PreloadResult<RoundTableTranscriptData>;
  readonly updateAgentMemoryPatchStatus: (params: {
    patchUuid: string;
    status: AgentMemoryPatchStatus;
  }) => PreloadResult<AgentMemoryPatchUpdateResult>;
}
