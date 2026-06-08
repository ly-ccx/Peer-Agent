import type {
  BranchConversationResult,
  ChatStreamStartResult,
  Conversation,
  ConversationListData,
  ConversationMutationResult,
  HumanConfirmationDecision,
  MessageContextData,
  MessageListData,
} from '@zeus-atlas/protocol';
import type { PreloadResult } from './apiResponse';

export interface ConversationPreloadApi {
  readonly listConversations: (params: {
    agentId?: number;
    limit?: number;
    offset?: number;
    status?: string;
    orderBy?: string;
    order?: 'asc' | 'desc';
  }) => PreloadResult<ConversationListData>;
  readonly createConversation: (params: {
    title: string;
    agentId?: number;
    metadata?: Record<string, unknown>;
  }) => PreloadResult<Conversation>;
  readonly getConversationDetail: (params: {
    id?: number;
    uuid?: string;
  }) => PreloadResult<Conversation>;
  readonly deleteConversation: (params: {
    id?: number;
    uuid?: string;
  }) => PreloadResult<ConversationMutationResult>;
  readonly branchFromMessage: (params: {
    sourceConversationId: number;
    upToMessageUuid: string;
    title?: string;
  }) => PreloadResult<BranchConversationResult>;
  readonly getMessages: (params: {
    conversationId: number;
    limit?: number;
    offset?: number;
    order?: 'asc' | 'desc';
    beforeId?: number;
  }) => PreloadResult<MessageListData>;
  readonly getMessageDetail: (params: {
    uuid: string;
  }) => PreloadResult<unknown>;
  readonly buildMessageContext: (params: {
    conversationId: number;
    limit?: number;
    maxTokens?: number;
  }) => PreloadResult<MessageContextData>;
  readonly getLastMessage: (params: {
    conversationId: number;
  }) => PreloadResult<unknown>;
  readonly deleteMessage: (params: {
    conversationId: number;
    messageId?: number;
    messageUuid?: string;
  }) => PreloadResult<ConversationMutationResult>;
  readonly truncateAfterMessage: (params: {
    conversationId: number;
    fromMessageId?: number;
    fromMessageUuid?: string;
  }) => PreloadResult<ConversationMutationResult>;
  readonly uploadImage: (params: {
    buffer: number[];
    fileName: string;
    mimeType: string;
  }) => Promise<string>;
  readonly startMessageStream: (params: {
    conversationId: number;
    content: string;
    mode?: { type: 'chat'; modelVersion?: string } | { type: 'agent'; agentId: number | string };
    context?: { description?: string; data?: Record<string, unknown> };
    images?: readonly string[];
    messageId?: string;
    accessMode?: 'share' | 'superpower';
  }) => Promise<ChatStreamStartResult>;
  readonly abortMessageStream: (streamId: string) => Promise<{ ok: boolean; code: string }>;
  readonly cancelStream: (params: {
    conversationId: number;
    messageId: string;
    reason?: string;
  }) => Promise<{ ok?: boolean; code?: string; status?: number; errorMsg?: string }>;
  readonly confirmExecution: (params: {
    executionUuid: string;
    confirmationId: string;
    decision: HumanConfirmationDecision | 'approve' | 'reject';
    feedback?: string;
    patch?: Record<string, unknown>;
  }) => PreloadResult<unknown>;
}
