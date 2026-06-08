import type {
  AgentDailyBillingTrendData,
  AgentListData,
  AssistantSuggestionListData,
  ConversationBillingSummary,
  ConversationMemoryCompileStatus,
  ConversationMemoryWikiPage,
  ConversationMemoryWikiPageListData,
  ConversationMemoryWikiStatus,
  InitializeConversationMemoryWikiResult,
  InlineCompletionData,
  ThinkingDetailData,
  ThinkingProcessListData,
  WorkingMemoryData,
} from '@zeus-atlas/protocol';
import { clientApi } from '../../clientApi';
import { unwrap } from './apiResponse';
import {
  normalizeAgentListData,
  normalizeInlineCompletion,
  normalizeSuggestionListData,
} from './chatNormalizers';

export const agentMemoryChatClient = {
  async getAssistantSuggestions(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getAssistantSuggestions']>[0]): Promise<AssistantSuggestionListData> {
    return normalizeSuggestionListData(unwrap(await clientApi.chat.getAssistantSuggestions(params), '加载输入建议失败'));
  },
  async getInlineCompletion(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getInlineCompletion']>[0]): Promise<InlineCompletionData> {
    return normalizeInlineCompletion(unwrap(await clientApi.chat.getInlineCompletion(params), '加载输入补全失败'));
  },
  async listAgents(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['listAgents']>[0]): Promise<AgentListData> {
    return normalizeAgentListData(unwrap(await clientApi.chat.listAgents(params), '加载 Agent 列表失败'));
  },
  async getWorkingMemory(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getWorkingMemory']>[0]): Promise<WorkingMemoryData> {
    return unwrap(await clientApi.chat.getWorkingMemory(params), '加载 Working Memory 失败');
  },
  initializeWorkingMemory: clientApi.chat.initializeWorkingMemory,
  async getMemoryWikiStatus(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getMemoryWikiStatus']>[0]): Promise<ConversationMemoryWikiStatus> {
    return unwrap(await clientApi.chat.getMemoryWikiStatus(params), '加载 Memory Wiki 状态失败');
  },
  async listMemoryWikiPages(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['listMemoryWikiPages']>[0]): Promise<ConversationMemoryWikiPageListData> {
    const data = unwrap(await clientApi.chat.listMemoryWikiPages(params), '加载 Memory Wiki 页面失败');
    return {
      ...data,
      list: data.list ?? data.pages ?? [],
    };
  },
  async readMemoryWikiPage(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['readMemoryWikiPage']>[0]): Promise<ConversationMemoryWikiPage> {
    return unwrap(await clientApi.chat.readMemoryWikiPage(params), '读取 Memory Wiki 页面失败');
  },
  async initializeMemoryWiki(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['initializeMemoryWiki']>[0]): Promise<InitializeConversationMemoryWikiResult> {
    return unwrap(await clientApi.chat.initializeMemoryWiki(params), '初始化 Memory Wiki 失败');
  },
  async getBillingSummary(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getBillingSummary']>[0]): Promise<ConversationBillingSummary> {
    return unwrap(await clientApi.chat.getBillingSummary(params), '加载 Billing 摘要失败');
  },
  async getAgentDailyBilling(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getAgentDailyBilling']>[0]): Promise<AgentDailyBillingTrendData> {
    return unwrap(await clientApi.chat.getAgentDailyBilling(params), '加载 Agent 日维度 Billing 失败');
  },
  async getMemoryCompileStatus(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getMemoryCompileStatus']>[0]): Promise<ConversationMemoryCompileStatus> {
    return unwrap(await clientApi.chat.getMemoryCompileStatus(params), '加载 Memory Compile 状态失败');
  },
  async retryMemoryCompile(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['retryMemoryCompile']>[0]): Promise<ConversationMemoryCompileStatus> {
    return unwrap(await clientApi.chat.retryMemoryCompile(params), '重试 Memory Compile 失败');
  },
  async listThinkingProcesses(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['listThinkingProcesses']>[0]): Promise<ThinkingProcessListData> {
    return unwrap(await clientApi.chat.listThinkingProcesses(params), '加载 Thinking 列表失败');
  },
  async getThinkingByMessage(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getThinkingByMessage']>[0]): Promise<ThinkingDetailData> {
    return unwrap(await clientApi.chat.getThinkingByMessage(params), '加载消息 Thinking 失败');
  },
};
