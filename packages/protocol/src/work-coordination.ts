export type ProjectWorkState = 'runnable' | 'waiting_children' | 'waiting_user' | 'retry_wait' | 'paused'
  | 'budget_limited' | 'blocked_system' | 'delivered' | 'cancelled';
export type ProjectTurnEnd = 'reply_committed' | 'awaiting_children' | 'yielded' | 'awaiting_user'
  | 'budget_limited' | 'provider_retryable' | 'no_progress' | 'user_stopped' | 'fatal';
export interface ProjectWorkReceipt {
  readonly schemaVersion: 1;
  readonly workId: string;
  readonly workspaceId: string;
  readonly parentConversationId: string;
  readonly anchorInputIds: readonly string[];
  readonly sessionIds: readonly string[];
  readonly state: ProjectWorkState;
  readonly revision: number;
  readonly checkpointRef?: string;
  readonly nativeCheckpointRef?: string;
  readonly end?: ProjectTurnEnd;
  readonly attemptId?: string;
  readonly pendingEventIds?: readonly string[];
  readonly waitFor: readonly { readonly kind: 'session' | 'approval' | 'question' | 'retry_timer'; readonly id: string }[];
  readonly consumedEventIds: readonly string[];
  readonly pendingResultRefs: readonly string[];
  readonly lastDeliveredFactKey?: string;
  readonly budgetRef?: string;
  readonly budget?: {
    readonly modelRequests: number; readonly toolCalls: number; readonly tokens: number; readonly costUsd: number;
    readonly unknownUsage: boolean; readonly unknownCost: boolean;
    readonly limits: { readonly maxModelRequests: number; readonly maxToolCalls: number; readonly maxTokens?: number; readonly maxCostUsd?: number; readonly source: string };
    readonly attempts: Readonly<Record<string, { readonly role: string; readonly requests?: number; readonly modelProviderId?: string;
      readonly checkpointRef?: string;
      readonly pendingTools?: readonly { readonly toolCallId: string | null; readonly capabilityId: string | null }[] }>>;
    readonly uncertainDispatches?: readonly { readonly attemptId: string; readonly role: string;
      readonly toolCallId: string | null; readonly capabilityId: string | null }[];
  };
  readonly stopScope: 'reply' | 'work';
  readonly updatedAt: string;
}
