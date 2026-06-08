import type {
  AgentDailyBillingTrendData,
  ConversationBillingSummary,
  ConversationMemoryCompileStatus,
  ConversationMemoryWikiPage,
  ConversationMemoryWikiPageListData,
  ConversationMemoryWikiStatus,
  InitializeConversationMemoryWikiResult,
  ThinkingDetailData,
  ThinkingProcessListData,
  WorkingMemoryData,
} from '@zeus-atlas/protocol';
import type { PreloadResult } from './apiResponse';

export interface AgentMemoryPreloadApi {
  readonly getAssistantSuggestions: (params: Record<string, unknown>) => PreloadResult<unknown>;
  readonly getInlineCompletion: (params: Record<string, unknown>) => PreloadResult<unknown>;
  readonly getAgentById: (params: { id: number | string }) => PreloadResult<unknown>;
  readonly listAgents: (params: Record<string, unknown>) => PreloadResult<unknown>;
  readonly getWorkingMemory: (params: {
    conversationId: number;
    agentId?: number;
  }) => PreloadResult<WorkingMemoryData>;
  readonly initializeWorkingMemory: (params: {
    conversationId: number;
    agentId?: number;
  }) => PreloadResult<ConversationMemoryCompileStatus>;
  readonly getMemoryWikiStatus: (params: {
    conversationId: number;
    agentId?: number;
  }) => PreloadResult<ConversationMemoryWikiStatus>;
  readonly listMemoryWikiPages: (params: {
    conversationId: number;
    agentId?: number;
    limit?: number;
    offset?: number;
  }) => PreloadResult<ConversationMemoryWikiPageListData>;
  readonly readMemoryWikiPage: (params: {
    conversationId: number;
    pageUuid?: string;
    pageKey?: string;
  }) => PreloadResult<ConversationMemoryWikiPage>;
  readonly initializeMemoryWiki: (params: {
    conversationId: number;
    agentId?: number;
    consumeLimit?: number;
  }) => PreloadResult<InitializeConversationMemoryWikiResult>;
  readonly getBillingSummary: (params: {
    conversationId?: number;
    agentId?: number;
  }) => PreloadResult<ConversationBillingSummary>;
  readonly getAgentDailyBilling: (params: {
    agentId: number;
    days?: number;
    startDate?: string;
    endDate?: string;
  }) => PreloadResult<AgentDailyBillingTrendData>;
  readonly getMemoryCompileStatus: (params: {
    conversationId: number;
    agentId?: number;
  }) => PreloadResult<ConversationMemoryCompileStatus>;
  readonly retryMemoryCompile: (params: {
    conversationId: number;
    agentId?: number;
  }) => PreloadResult<ConversationMemoryCompileStatus>;
  readonly listThinkingProcesses: (params: {
    conversationId?: number;
    messageId?: number;
    skillId?: string | number;
    status?: string;
    limit?: number;
    offset?: number;
  }) => PreloadResult<ThinkingProcessListData>;
  readonly getThinkingByMessage: (params: {
    messageId: number;
    includeFull?: boolean;
  }) => PreloadResult<ThinkingDetailData>;
}
