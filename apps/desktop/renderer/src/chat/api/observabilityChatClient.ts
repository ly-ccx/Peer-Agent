import type {
  AiChatTraceData,
  ChatStatisticsCloudExportResult,
  ChatStatisticsLocalExportResult,
  ChatStatisticsOverviewData,
  ChatStatisticsRankingData,
  ChatStatisticsRealtimeData,
  ChatStatisticsTrendData,
  ToolCallListData,
  ToolCallRecord,
  ToolCallStatisticsData,
} from '@zeus-atlas/protocol';
import { clientApi } from '../../clientApi';
import { unwrap } from './apiResponse';
import { normalizeToolCallListData } from './chatNormalizers';

export const observabilityChatClient = {
  async getMessageTrace(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getMessageTrace']>[0]): Promise<AiChatTraceData> {
    return unwrap(await clientApi.chat.getMessageTrace(params), '加载消息 Trace 失败');
  },
  async getConversationTrace(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getConversationTrace']>[0]): Promise<AiChatTraceData> {
    return unwrap(await clientApi.chat.getConversationTrace(params), '加载会话 Trace 失败');
  },
  async getToolCallDetail(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getToolCallDetail']>[0]): Promise<ToolCallRecord> {
    return unwrap(await clientApi.chat.getToolCallDetail(params), '加载 Tool Call 详情失败');
  },
  async listToolCalls(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['listToolCalls']>[0]): Promise<ToolCallListData> {
    return normalizeToolCallListData(unwrap(await clientApi.chat.listToolCalls(params), '加载 Tool Call 列表失败'));
  },
  async getConversationToolCallStatistics(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getConversationToolCallStatistics']>[0]): Promise<ToolCallStatisticsData> {
    return unwrap(await clientApi.chat.getConversationToolCallStatistics(params), '加载 Tool Call 统计失败');
  },
  async getRecentToolCalls(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getRecentToolCalls']>[0]): Promise<ToolCallListData> {
    return normalizeToolCallListData(unwrap(await clientApi.chat.getRecentToolCalls(params), '加载最近 Tool Call 失败'));
  },
  async getMessageToolCalls(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getMessageToolCalls']>[0]): Promise<ToolCallListData> {
    return normalizeToolCallListData(unwrap(await clientApi.chat.getMessageToolCalls(params), '加载消息 Tool Call 失败'));
  },
  async getChatStatisticsOverview(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getChatStatisticsOverview']>[0]): Promise<ChatStatisticsOverviewData> {
    return unwrap(await clientApi.chat.getChatStatisticsOverview(params), '加载统计概览失败');
  },
  async getChatStatisticsTrends(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getChatStatisticsTrends']>[0]): Promise<ChatStatisticsTrendData> {
    return unwrap(await clientApi.chat.getChatStatisticsTrends(params), '加载统计趋势失败');
  },
  async getChatStatisticsToolRanking(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getChatStatisticsToolRanking']>[0]): Promise<ChatStatisticsRankingData> {
    return unwrap(await clientApi.chat.getChatStatisticsToolRanking(params), '加载工具排行失败');
  },
  async getChatStatisticsUserRanking(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getChatStatisticsUserRanking']>[0]): Promise<ChatStatisticsRankingData> {
    return unwrap(await clientApi.chat.getChatStatisticsUserRanking(params), '加载用户排行失败');
  },
  async getChatStatisticsRealtime(params?: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getChatStatisticsRealtime']>[0]): Promise<ChatStatisticsRealtimeData> {
    return unwrap(await clientApi.chat.getChatStatisticsRealtime(params), '加载实时统计失败');
  },
  async exportChatStatistics(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['exportChatStatistics']>[0]): Promise<ChatStatisticsCloudExportResult> {
    return unwrap(await clientApi.chat.exportChatStatistics(params), '云端导出统计失败');
  },
  async exportChatStatisticsSnapshot(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['exportChatStatisticsSnapshot']>[0]): Promise<ChatStatisticsLocalExportResult> {
    return clientApi.chat.exportChatStatisticsSnapshot(params);
  },
};
