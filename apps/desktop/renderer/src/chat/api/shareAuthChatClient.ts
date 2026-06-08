import type {
  AuthBaseListData,
  AuthBaseRecord,
  BranchConversationResult,
  ChatAccessCheckResult,
  ChatShare,
  ChatShareDetail,
  ChatShareListData,
  Conversation,
  ConversationMutationResult,
} from '@zeus-atlas/protocol';
import { clientApi } from '../../clientApi';
import { unwrap } from './apiResponse';

export const shareAuthChatClient = {
  async createShare(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['createShare']>[0]): Promise<ChatShare> {
    return unwrap(await clientApi.chat.createShare(params), '创建分享失败');
  },
  async listShares(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['listShares']>[0]): Promise<ChatShareListData> {
    const data = unwrap(await clientApi.chat.listShares(params), '加载分享列表失败') as ChatShareListData & {
      readonly items?: readonly ChatShare[];
      readonly shares?: readonly ChatShare[];
    };
    const list = data.list ?? data.items ?? data.shares ?? [];
    return {
      ...data,
      list,
      total: typeof data.total === 'number' ? data.total : list.length,
    };
  },
  async getShareDetail(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getShareDetail']>[0]): Promise<ChatShareDetail> {
    return unwrap(await clientApi.chat.getShareDetail(params), '加载分享详情失败');
  },
  async continueShare(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['continueShare']>[0]): Promise<BranchConversationResult> {
    return unwrap(await clientApi.chat.continueShare(params), '继续分享失败');
  },
  async revokeShare(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['revokeShare']>[0]): Promise<ConversationMutationResult> {
    return unwrap(await clientApi.chat.revokeShare(params), '撤销分享失败');
  },
  async checkAccess(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['checkAccess']>[0]): Promise<ChatAccessCheckResult> {
    return unwrap(await clientApi.chat.checkAccess(params), '加载访问权限失败');
  },
  async updateSpectatorConfig(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['updateSpectatorConfig']>[0]): Promise<Conversation> {
    return unwrap(await clientApi.chat.updateSpectatorConfig(params), '更新旁观配置失败');
  },
  async createConversationAuth(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['createConversationAuth']>[0]): Promise<AuthBaseRecord> {
    return unwrap(await clientApi.chat.createConversationAuth(params), '创建会话权限失败');
  },
  async getConversationAuthDetail(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getConversationAuthDetail']>[0]): Promise<AuthBaseRecord> {
    return unwrap(await clientApi.chat.getConversationAuthDetail(params), '加载会话权限详情失败');
  },
  async updateConversationAuthMembers(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['updateConversationAuthMembers']>[0]): Promise<AuthBaseRecord> {
    return unwrap(await clientApi.chat.updateConversationAuthMembers(params), '更新会话权限名单失败');
  },
  async listAuthBase(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['listAuthBase']>[0]): Promise<AuthBaseListData> {
    return unwrap(await clientApi.chat.listAuthBase(params), '加载权限列表失败');
  },
  async updateShareAccess(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['updateShareAccess']>[0]): Promise<ChatShare> {
    return unwrap(await clientApi.chat.updateShareAccess(params), '更新分享访问权限失败');
  },
  async createShareAuth(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['createShareAuth']>[0]): Promise<AuthBaseRecord> {
    return unwrap(await clientApi.chat.createShareAuth(params), '创建分享权限失败');
  },
  async getShareAuthDetail(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getShareAuthDetail']>[0]): Promise<AuthBaseRecord> {
    return unwrap(await clientApi.chat.getShareAuthDetail(params), '加载分享权限详情失败');
  },
  async updateShareAuthMembers(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['updateShareAuthMembers']>[0]): Promise<AuthBaseRecord> {
    return unwrap(await clientApi.chat.updateShareAuthMembers(params), '更新分享权限名单失败');
  },
};
