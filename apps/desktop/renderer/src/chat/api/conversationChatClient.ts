import type {
  BranchConversationResult,
  Conversation,
  ConversationListData,
  ConversationMutationResult,
  MessageContextData,
  MessageListData,
} from '@zeus-atlas/protocol';
import { clientApi } from '../../clientApi';
import { unwrap } from './apiResponse';
import { normalizeChatMessage } from './chatNormalizers';

export const conversationChatClient = {
  async listConversations(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['listConversations']>[0]): Promise<ConversationListData> {
    return unwrap(await clientApi.chat.listConversations(params), '加载会话列表失败');
  },

  async createConversation(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['createConversation']>[0]): Promise<Conversation> {
    return unwrap(await clientApi.chat.createConversation(params), '创建会话失败');
  },

  async getConversationDetail(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getConversationDetail']>[0]): Promise<Conversation> {
    return unwrap(await clientApi.chat.getConversationDetail(params), '加载会话详情失败');
  },

  async deleteConversation(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['deleteConversation']>[0]): Promise<ConversationMutationResult> {
    return unwrap(await clientApi.chat.deleteConversation(params), '删除会话失败');
  },

  async branchFromMessage(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['branchFromMessage']>[0]): Promise<BranchConversationResult> {
    return unwrap(await clientApi.chat.branchFromMessage(params), '创建分支会话失败');
  },

  async getMessages(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getMessages']>[0]): Promise<MessageListData> {
    const data = unwrap(await clientApi.chat.getMessages(params), '加载消息失败');
    return {
      ...data,
      list: data.list.map(normalizeChatMessage),
    };
  },

  async getMessageDetail(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getMessageDetail']>[0]): Promise<unknown> {
    return unwrap(await clientApi.chat.getMessageDetail(params), '加载消息详情失败');
  },

  async buildMessageContext(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['buildMessageContext']>[0]): Promise<MessageContextData> {
    return unwrap(await clientApi.chat.buildMessageContext(params), '加载消息上下文失败');
  },

  async getLastMessage(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['getLastMessage']>[0]): Promise<unknown> {
    return unwrap(await clientApi.chat.getLastMessage(params), '加载最后消息失败');
  },

  async deleteMessage(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['deleteMessage']>[0]): Promise<ConversationMutationResult> {
    return unwrap(await clientApi.chat.deleteMessage(params), '删除消息失败');
  },

  async truncateAfterMessage(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['truncateAfterMessage']>[0]): Promise<ConversationMutationResult> {
    return unwrap(await clientApi.chat.truncateAfterMessage(params), '截断消息失败');
  },

  async createShare(params: Parameters<NonNullable<Window['zeusAtlas']>['chat']['createShare']>[0]): Promise<any> {
    return unwrap(await clientApi.chat.createShare(params), '创建分享失败');
  },

  startMessageStream: clientApi.chat.startMessageStream,
  abortMessageStream: clientApi.chat.abortMessageStream,
  cancelStream: clientApi.chat.cancelStream,
  confirmExecution: clientApi.chat.confirmExecution,
};
