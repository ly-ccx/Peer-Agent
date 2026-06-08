import type {
  ConversationMutationResult,
  DispatchConfirmResult,
  ExecutionCancelResult,
  ExecutionCotSnapshot,
  ExecutionDetailData,
  ExecutionListData,
  ExecutionResultData,
  ExecutionSourceTraceData,
  ExecutionStatusSnapshot,
  PendingDispatchResult,
  RelatedShadowExecutionListData,
  ThinkingDetailData,
} from '@zeus-atlas/protocol';
import type { PreloadResult } from './apiResponse';

export interface ExecutionPreloadApi {
  readonly getExecutionStatus: (params: { executionUuid: string }) => PreloadResult<ExecutionStatusSnapshot>;
  readonly getExecutionDetail: (params: { executionUuid: string }) => PreloadResult<ExecutionDetailData>;
  readonly getExecutionResult: (params: { executionUuid: string }) => PreloadResult<ExecutionResultData>;
  readonly getExecutionCot: (params: { executionUuid: string }) => PreloadResult<ExecutionCotSnapshot>;
  readonly traceExecutionSource: (params: {
    executionUuid: string;
    runId?: string;
    step: number;
    fieldPath?: string;
    maxCandidates?: number;
    matchMode?: 'exact' | 'hybrid';
  }) => PreloadResult<ExecutionSourceTraceData>;
  readonly listExecutions: (params: {
    status?: string;
    skillId?: string;
    page?: number;
    pageSize?: number;
  }) => PreloadResult<ExecutionListData | readonly ExecutionDetailData[]>;
  readonly listRelatedShadowExecutions: (params: {
    currentExecutionUuid?: string;
    skillId?: string;
    agentId?: number | string;
    newerLimit?: number;
    olderLimit?: number;
    limit?: number;
  }) => PreloadResult<RelatedShadowExecutionListData | readonly ExecutionDetailData[]>;
  readonly cancelExecution: (params: { executionUuid: string }) => PreloadResult<ExecutionCancelResult>;
  readonly getPendingDispatch: (params: { conversationId: number }) => PreloadResult<PendingDispatchResult>;
  readonly confirmDispatch: (params: {
    sessionId: string;
    approved: boolean;
    feedback?: string;
  }) => PreloadResult<DispatchConfirmResult>;
  readonly pollExecutionEvents: (params: { executionUuid: string; lastEventId: number }) => PreloadResult<unknown>;
  readonly getThinkingDetail: (params: { processUuid: string }) => PreloadResult<ThinkingDetailData>;
  readonly updateThinkingUiState: (params: {
    processUuid: string;
    expanded?: boolean;
    toolStates?: readonly { toolCallId: string; collapsed: boolean }[];
  }) => PreloadResult<ConversationMutationResult>;
}
