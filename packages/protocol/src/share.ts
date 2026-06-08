import type { ConversationLineage } from './chat.ts';

export type ChatShareMode = 'full_conversation' | 'message_selection';

export type ChatShareStatus = 'active' | 'published' | 'revoked';

export interface ChatShareIncludeOptions {
  readonly includeUserMessages?: boolean;
  readonly includeAssistantMessages?: boolean;
  readonly includeRenderData?: boolean;
  readonly includeThinking?: boolean;
  readonly includeToolResults?: boolean;
  readonly includeToolTraces?: boolean;
  readonly includeImages?: boolean;
  readonly includeReferences?: boolean;
}

export interface ChatShare {
  readonly id?: number;
  readonly shareUuid: string;
  readonly title: string;
  readonly description?: string;
  readonly ownerWorkId: string;
  readonly sourceConversationId: number;
  readonly sourceConversationUuid?: string;
  readonly sourceAgentId?: number;
  readonly mode: ChatShareMode;
  readonly status: ChatShareStatus;
  readonly continuePolicy: 'disabled' | 'fork_only';
  readonly snapshotMessageCount: number;
  readonly selectedMessageCount?: number;
  readonly includeOptions?: ChatShareIncludeOptions;
  readonly summary?: string;
  readonly aclKey?: string | null;
  readonly derivationCount?: number;
  readonly gmtCreate?: string;
  readonly gmtPublished?: string;
}

export interface ChatShareItem {
  readonly id: number;
  readonly shareUuid?: string;
  readonly orderNo?: number;
  readonly sourceMessageId?: number;
  readonly sourceMessageUuid?: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool' | string;
  readonly contentSnapshot: string;
  readonly renderDataSnapshot?: unknown;
  readonly metadataSnapshot?: unknown;
  readonly senderInfo?: unknown;
  readonly executionUuid?: string;
  readonly inclusionReason?: string;
  readonly explicitSelected?: boolean;
  readonly gmtCreate?: string;
}

export interface ChatShareDetail {
  readonly share: ChatShare;
  readonly items: readonly ChatShareItem[];
  readonly lineage?: ConversationLineage;
  readonly derivationCount: number;
}

export interface ChatShareListData {
  readonly list: readonly ChatShare[];
  readonly total: number;
  readonly limit?: number;
  readonly offset?: number;
}
