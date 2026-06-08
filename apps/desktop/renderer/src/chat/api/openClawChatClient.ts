import type {
  OpenClawAgentChannelListData,
  OpenClawAgentChannelSessionListData,
  OpenClawConversationEffectiveConfigData,
  OpenClawEffectiveAgentConfigData,
  OpenClawEnterResultData,
  OpenClawGovernanceCatalogData,
  OpenClawSceneData,
  OpenClawSceneEventListData,
} from '@zeus-atlas/protocol';
import { clientApi } from '../../clientApi';
import { unwrap } from './apiResponse';
import { openClawGovernanceChatClient } from './openClawGovernanceChatClient';

export const openClawChatClient = {
  async getOpenClawCurrentScene(): Promise<OpenClawSceneData> {
    return unwrap(await clientApi.chat.getOpenClawCurrentScene(), '加载 OpenClaw 当前场景失败');
  },
  async getOpenClawSceneEvents(params?: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getOpenClawSceneEvents']>[0]): Promise<OpenClawSceneEventListData> {
    return unwrap(await clientApi.chat.getOpenClawSceneEvents(params), '加载 OpenClaw 场景事件失败');
  },
  async listOpenClawAgentChannels(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['listOpenClawAgentChannels']>[0]): Promise<OpenClawAgentChannelListData> {
    return unwrap(await clientApi.chat.listOpenClawAgentChannels(params), '加载 Agent Channel 失败');
  },
  async listOpenClawAgentChannelSessions(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['listOpenClawAgentChannelSessions']>[0]): Promise<OpenClawAgentChannelSessionListData> {
    return unwrap(await clientApi.chat.listOpenClawAgentChannelSessions(params), '加载 Channel Session 失败');
  },
  async enterOpenClawAgentChat(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['enterOpenClawAgentChat']>[0]): Promise<OpenClawEnterResultData> {
    return unwrap(await clientApi.chat.enterOpenClawAgentChat(params), '进入 Agent Chat 失败');
  },
  async enterOpenClawAgentChannelSession(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['enterOpenClawAgentChannelSession']>[0]): Promise<OpenClawEnterResultData> {
    return unwrap(await clientApi.chat.enterOpenClawAgentChannelSession(params), '进入 Channel Session 失败');
  },
  async getOpenClawGovernanceCatalog(): Promise<OpenClawGovernanceCatalogData> {
    return unwrap(await clientApi.chat.getOpenClawGovernanceCatalog(), '加载 OpenClaw Governance 目录失败');
  },
  ...openClawGovernanceChatClient,
  async resolveOpenClawEffectiveAgentConfig(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['resolveOpenClawEffectiveAgentConfig']>[0]): Promise<OpenClawEffectiveAgentConfigData> {
    return unwrap(await clientApi.chat.resolveOpenClawEffectiveAgentConfig(params), '解析 Effective Agent Config 失败');
  },
  async resolveOpenClawConversationEffectiveConfig(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['resolveOpenClawConversationEffectiveConfig']>[0]): Promise<OpenClawConversationEffectiveConfigData> {
    return unwrap(await clientApi.chat.resolveOpenClawConversationEffectiveConfig(params), '解析会话 Effective Config 失败');
  },
};
