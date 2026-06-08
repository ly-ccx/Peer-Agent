import type {
  AiChatTraceData,
  ChatStatisticsCloudExportRequest,
  ChatStatisticsCloudExportResult,
  ChatStatisticsLocalExportRequest,
  ChatStatisticsLocalExportResult,
  ChatStatisticsOverviewData,
  ChatStatisticsRankingData,
  ChatStatisticsRealtimeData,
  ChatStatisticsTrendData,
  ToolCallListData,
  ToolCallRecord,
  ToolCallStatisticsData,
} from '@zeus-atlas/protocol';
import type { PreloadResult } from './apiResponse';

export interface ObservabilityPreloadApi {
  readonly getMessageTrace: (params: {
    messageId?: number;
    messageUuid?: string;
    assistantMessageUuid?: string;
  }) => PreloadResult<AiChatTraceData>;
  readonly getConversationTrace: (params: {
    conversationId?: number;
    conversationUuid?: string;
    uuid?: string;
  }) => PreloadResult<AiChatTraceData>;
  readonly getToolCallDetail: (params: { uuid: string }) => PreloadResult<ToolCallRecord>;
  readonly listToolCalls: (params: {
    conversationId?: number;
    messageId?: number;
    status?: string;
    toolName?: string;
    limit?: number;
    offset?: number;
  }) => PreloadResult<ToolCallListData | readonly ToolCallRecord[]>;
  readonly getConversationToolCallStatistics: (params: { conversationId: number }) => PreloadResult<ToolCallStatisticsData>;
  readonly getRecentToolCalls: (params: {
    conversationId: number;
    limit?: number;
  }) => PreloadResult<ToolCallListData | readonly ToolCallRecord[]>;
  readonly getMessageToolCalls: (params: { messageId: number }) => PreloadResult<ToolCallListData | readonly ToolCallRecord[]>;
  readonly getChatStatisticsOverview: (params: {
    startDate: string;
    endDate: string;
  }) => PreloadResult<ChatStatisticsOverviewData>;
  readonly getChatStatisticsTrends: (params: {
    startDate: string;
    endDate: string;
    granularity: 'day' | 'week' | 'month';
    metrics?: readonly string[];
  }) => PreloadResult<ChatStatisticsTrendData>;
  readonly getChatStatisticsToolRanking: (params: {
    startDate: string;
    endDate: string;
    sortBy?: 'totalCalls' | 'successRate' | 'avgDuration';
    order?: 'asc' | 'desc';
    limit?: number;
  }) => PreloadResult<ChatStatisticsRankingData>;
  readonly getChatStatisticsUserRanking: (params: {
    startDate: string;
    endDate: string;
    sortBy?: 'conversations' | 'messages' | 'toolCalls';
    limit?: number;
  }) => PreloadResult<ChatStatisticsRankingData>;
  readonly getChatStatisticsRealtime: (params?: Record<string, never>) => PreloadResult<ChatStatisticsRealtimeData>;
  readonly exportChatStatistics: (params: ChatStatisticsCloudExportRequest) => PreloadResult<ChatStatisticsCloudExportResult>;
  readonly exportChatStatisticsSnapshot: (params: ChatStatisticsLocalExportRequest) => Promise<ChatStatisticsLocalExportResult>;
}
