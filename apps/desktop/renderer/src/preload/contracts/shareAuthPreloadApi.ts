import type {
  AuthBaseListData,
  AuthBaseRecord,
  BranchConversationResult,
  ChatAccessCheckResult,
  ChatShare,
  ChatShareDetail,
  ChatShareIncludeOptions,
  ChatShareListData,
  ChatShareMode,
  Conversation,
  ConversationMutationResult,
} from '@zeus-atlas/protocol';
import type { PreloadResult } from './apiResponse';

export interface ShareAuthPreloadApi {
  readonly createShare: (params: {
    conversationId: number;
    title?: string;
    description?: string;
    mode?: ChatShareMode;
    selectedMessageIds?: readonly number[];
    selectedMessageUuids?: readonly string[];
    includeOptions?: ChatShareIncludeOptions;
    continuePolicy?: 'disabled' | 'fork_only';
  }) => PreloadResult<ChatShare>;
  readonly listShares: (params: {
    conversationId?: number;
    status?: string;
    limit?: number;
    offset?: number;
  }) => PreloadResult<ChatShareListData>;
  readonly getShareDetail: (params: { shareUuid: string }) => PreloadResult<ChatShareDetail>;
  readonly continueShare: (params: {
    shareUuid: string;
    title?: string;
  }) => PreloadResult<BranchConversationResult>;
  readonly revokeShare: (params: {
    shareUuid: string;
  }) => PreloadResult<ConversationMutationResult>;
  readonly checkAccess: (params: {
    conversationId?: number;
    shareUuid?: string;
    bucId?: number;
  }) => PreloadResult<ChatAccessCheckResult>;
  readonly updateSpectatorConfig: (params: {
    conversationId: number;
    spectatorEnabled: boolean;
    spectatorAclKey?: string | null;
  }) => PreloadResult<Conversation>;
  readonly createConversationAuth: (params: {
    conversationId: number;
  }) => PreloadResult<AuthBaseRecord>;
  readonly getConversationAuthDetail: (params: {
    conversationId: number;
  }) => PreloadResult<AuthBaseRecord>;
  readonly updateConversationAuthMembers: (params: {
    conversationId: number;
    white?: string;
    black?: string;
  }) => PreloadResult<AuthBaseRecord>;
  readonly listAuthBase: (params: {
    keyword?: string;
    pageNo?: number;
    pageSize?: number;
  }) => PreloadResult<AuthBaseListData>;
  readonly updateShareAccess: (params: {
    shareUuid: string;
    aclKey?: string | null;
  }) => PreloadResult<ChatShare>;
  readonly createShareAuth: (params: {
    shareUuid: string;
  }) => PreloadResult<AuthBaseRecord>;
  readonly getShareAuthDetail: (params: {
    shareUuid: string;
  }) => PreloadResult<AuthBaseRecord>;
  readonly updateShareAuthMembers: (params: {
    shareUuid: string;
    white?: string;
    black?: string;
  }) => PreloadResult<AuthBaseRecord>;
}
