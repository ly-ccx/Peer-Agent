import type {
  PendingDispatch,
  PendingHumanConfirmation,
  ResolvedHumanConfirmation,
  ThinkingProcess,
} from './execution.ts';

export type ConversationStatus = 'active' | 'inactive' | 'archived';

export interface ConversationMetadata {
  readonly source?: string;
  readonly [key: string]: unknown;
}

export interface Conversation {
  readonly id: number;
  readonly conversationUuid: string;
  readonly title: string;
  readonly agentId?: number;
  readonly status: ConversationStatus;
  readonly metadata?: ConversationMetadata;
  readonly spectatorEnabled?: boolean;
  readonly spectatorAclKey?: string | null;
  readonly messageCount?: number;
  readonly gmtCreate?: string;
  readonly gmtModified?: string;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export type MessageStatus = 'sending' | 'streaming' | 'done' | 'error';

export interface MessageReference {
  readonly scopeId: string;
  readonly label: string;
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
}

export interface MessageImage {
  readonly url: string;
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface AssistantAction {
  readonly id: string;
  readonly label: string;
  readonly style?: 'primary' | 'default' | 'danger';
  readonly skillId: string;
  readonly payload: {
    readonly type: string;
    readonly data?: unknown;
    readonly messageUuid?: string;
  };
}

export interface ChatMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly timestamp: number;
  readonly status?: MessageStatus;
  readonly messageUuid?: string;
  readonly rawMessageId?: number;
  readonly images?: readonly MessageImage[];
  readonly references?: readonly MessageReference[];
  readonly actions?: readonly AssistantAction[];
  readonly skillId?: string | number;
  readonly skillName?: string;
  readonly aiData?: unknown;
  readonly renderData?: unknown;
  readonly thinkingProcess?: ThinkingProcess;
  readonly pendingDispatch?: PendingDispatch;
  readonly pendingHumanConfirmation?: PendingHumanConfirmation;
  readonly resolvedHumanConfirmation?: ResolvedHumanConfirmation;
  readonly humanConfirmationHistory?: readonly ResolvedHumanConfirmation[];
  readonly sender?: {
    readonly id: number;
    readonly name: string;
    readonly type: 'siliconEmployee' | 'agent';
    readonly depth: number;
    readonly orgRole?: string;
  };
}

export type MessageSource =
  | {
      readonly kind: 'live';
      readonly conversationId: number;
    }
  | {
      readonly kind: 'frozen';
      readonly shareUuid: string;
    }
  | {
      readonly kind: 'hybrid';
      readonly conversationId: number;
      readonly shareUuid: string;
    };

export interface ConversationCapabilities {
  readonly canSend: boolean;
  readonly canEdit: boolean;
  readonly canBranch: boolean;
  readonly canShare: boolean;
}

export type ConversationLineage =
  | {
      readonly kind: 'sharedFrom';
      readonly shareUuid: string;
      readonly ownerWorkId: string;
      readonly title: string;
      readonly snapshotMessageCount: number;
      readonly continuePolicy: 'disabled' | 'fork_only';
      readonly derivationCount?: number;
    }
  | {
      readonly kind: 'derivedFrom';
      readonly shareUuid: string;
      readonly ownerWorkId: string;
      readonly title: string;
      readonly snapshotMessageCount: number;
    }
  | null;

export interface ConversationView {
  readonly source: MessageSource;
  readonly capabilities: ConversationCapabilities;
  readonly lineage: ConversationLineage;
  readonly readOnly: boolean;
}

export type MessageNodeOrigin = 'live' | 'frozen';

export interface MessageActions {
  readonly copy: boolean;
  readonly regenerate: boolean;
  readonly delete: boolean;
  readonly branch: boolean;
  readonly snapshot: boolean;
}

export interface ChatRuntimeState {
  readonly conversation: Conversation | null;
  readonly view: ConversationView | null;
  readonly messages: readonly ChatMessage[];
  readonly isStreaming: boolean;
  readonly currentAssistantMessageId?: string;
  readonly currentExecutionUuid?: string;
  /**
   * 当前用户消息触发的 run 标识（= userMessageUuid），由后端 `run_started`
   * SSE 事件设置。main 进程在原 SSE 流断后用它作为重订阅
   * `/api/chat/agent-runs/:runId/stream` 的寻址 key，跨多轮 pause-resume 持久。
   */
  readonly currentRunId?: string;
  readonly pendingConfirmations: readonly PendingHumanConfirmation[];
  readonly lastEventAt?: string;
  readonly error?: string;
}

export interface ChatStreamEvent {
  readonly event: string;
  readonly data: unknown;
  readonly id?: string;
  readonly retry?: number;
}

export interface ConversationListData {
  readonly list: readonly Conversation[];
  readonly total: number;
  readonly limit?: number;
  readonly offset?: number;
}

export interface MessageListData {
  readonly list: readonly ChatMessage[];
  readonly total: number;
  readonly limit?: number;
  readonly offset?: number;
  readonly hasMore?: boolean;
}

export interface ChatStreamStartResult {
  readonly streamId: string;
}

export interface ChatStreamEventEnvelope {
  readonly streamId: string;
  readonly event: ChatStreamEvent;
  readonly receivedAt: string;
}

export interface ChatStreamDoneEnvelope {
  readonly streamId: string;
  readonly completedAt: string;
}

export interface ChatStreamErrorEnvelope {
  readonly streamId: string;
  readonly error: string;
  readonly failedAt: string;
}

export interface ConversationMutationResult {
  readonly ok?: boolean;
  readonly code?: string;
  readonly message?: string;
}

export interface BranchConversationResult {
  readonly conversation: Conversation;
  readonly messages?: readonly ChatMessage[];
}

export interface ThinkingDetailData {
  readonly conversationId?: number;
  readonly messageId?: number;
  readonly messageUuid?: string;
  readonly thinkingProcess?: ThinkingProcess;
  readonly events?: readonly ChatStreamEvent[];
}

export interface AgentSummary {
  readonly id: number | string;
  readonly name: string;
  readonly description?: string;
  readonly avatar?: string;
  readonly status?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentListData {
  readonly list: readonly AgentSummary[];
  readonly total?: number;
}

export interface AssistantSuggestion {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
  readonly description?: string;
  readonly source?: string;
}

export interface AssistantSuggestionListData {
  readonly list: readonly AssistantSuggestion[];
}

export interface InlineCompletionData {
  readonly text: string;
  readonly source?: string;
}

export const FULL_CONVERSATION_CAPABILITIES: ConversationCapabilities = {
  canSend: true,
  canEdit: true,
  canBranch: true,
  canShare: true,
};

export const READ_ONLY_CONVERSATION_CAPABILITIES: ConversationCapabilities = {
  canSend: false,
  canEdit: false,
  canBranch: true,
  canShare: false,
};

export const STRICT_SPECTATOR_CONVERSATION_CAPABILITIES: ConversationCapabilities = {
  canSend: false,
  canEdit: false,
  canBranch: false,
  canShare: false,
};

export function isReadOnlyConversation(capabilities: ConversationCapabilities): boolean {
  return !capabilities.canSend && !capabilities.canEdit && !capabilities.canShare;
}

export function buildConversationView(params: {
  readonly source: MessageSource;
  readonly capabilities: ConversationCapabilities;
  readonly lineage?: ConversationLineage;
}): ConversationView {
  return {
    source: params.source,
    capabilities: params.capabilities,
    lineage: params.lineage ?? null,
    readOnly: isReadOnlyConversation(params.capabilities),
  };
}
