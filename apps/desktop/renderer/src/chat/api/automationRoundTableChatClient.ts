import type {
  AgentCronRunListData,
  AgentCronSessionListData,
  AgentCronSessionRecord,
  AgentMemoryPatchUpdateResult,
  RoundTableAbortResult,
  RoundTableInjectResult,
  RoundTableTranscriptData,
} from '@zeus-atlas/protocol';
import { clientApi } from '../../clientApi';
import { unwrap } from './apiResponse';
import {
  normalizeAgentCronRunListData,
  normalizeAgentCronSessionListData,
} from './chatNormalizers';

export const automationRoundTableChatClient = {
  async listAgentCronSessions(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['listAgentCronSessions']>[0]): Promise<AgentCronSessionListData> {
    return normalizeAgentCronSessionListData(unwrap(await clientApi.chat.listAgentCronSessions(params), '加载 Automation 会话失败'));
  },
  async getAgentCronSessionDetail(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getAgentCronSessionDetail']>[0]): Promise<AgentCronSessionRecord> {
    return unwrap(await clientApi.chat.getAgentCronSessionDetail(params), '加载 Automation 详情失败');
  },
  async createAgentCronSession(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['createAgentCronSession']>[0]): Promise<unknown> {
    return unwrap(await clientApi.chat.createAgentCronSession(params), '创建 Automation 失败');
  },
  async updateAgentCronSession(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['updateAgentCronSession']>[0]): Promise<unknown> {
    return unwrap(await clientApi.chat.updateAgentCronSession(params), '更新 Automation 失败');
  },
  async pauseAgentCronSession(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['pauseAgentCronSession']>[0]): Promise<AgentCronSessionRecord> {
    return unwrap(await clientApi.chat.pauseAgentCronSession(params), '暂停 Automation 失败');
  },
  async resumeAgentCronSession(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['resumeAgentCronSession']>[0]): Promise<AgentCronSessionRecord> {
    return unwrap(await clientApi.chat.resumeAgentCronSession(params), '恢复 Automation 失败');
  },
  async completeAgentCronSession(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['completeAgentCronSession']>[0]): Promise<AgentCronSessionRecord> {
    return unwrap(await clientApi.chat.completeAgentCronSession(params), '完成 Automation 失败');
  },
  async recoverAgentCronSessionOpenRuns(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['recoverAgentCronSessionOpenRuns']>[0]): Promise<unknown> {
    return unwrap(await clientApi.chat.recoverAgentCronSessionOpenRuns(params), '恢复 Automation 运行失败');
  },
  async listAgentCronRuns(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['listAgentCronRuns']>[0]): Promise<AgentCronRunListData> {
    return normalizeAgentCronRunListData(unwrap(await clientApi.chat.listAgentCronRuns(params), '加载 Automation 运行记录失败'));
  },
  async injectRoundTableTurn(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['injectRoundTableTurn']>[0]): Promise<RoundTableInjectResult> {
    return unwrap(await clientApi.chat.injectRoundTableTurn(params), '圆桌插话失败');
  },
  async abortRoundTableTurn(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['abortRoundTableTurn']>[0]): Promise<RoundTableAbortResult> {
    return unwrap(await clientApi.chat.abortRoundTableTurn(params), '停止圆桌失败');
  },
  async getRoundTableTranscript(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getRoundTableTranscript']>[0]): Promise<RoundTableTranscriptData> {
    return unwrap(await clientApi.chat.getRoundTableTranscript(params), '加载圆桌记录失败');
  },
  async updateAgentMemoryPatchStatus(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['updateAgentMemoryPatchStatus']>[0]): Promise<AgentMemoryPatchUpdateResult> {
    return unwrap(await clientApi.chat.updateAgentMemoryPatchStatus(params), '更新进化 Patch 状态失败');
  },
};
