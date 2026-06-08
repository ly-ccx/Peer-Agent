export interface WorkingMemorySection {
  readonly key: string;
  readonly title: string;
  readonly content: string;
  readonly priority?: number;
  readonly source?: 'conversation' | 'agent' | 'local_preview';
}

export interface WorkingMemorySnapshotEntry {
  readonly id?: number;
  readonly itemType?: string;
  readonly title?: string | null;
  readonly content: string;
  readonly sourceMessageId?: number | null;
  readonly sourceRefId?: string | null;
  readonly gmtModified?: string | null;
}

export interface WorkingMemorySnapshotJson {
  readonly currentGoal?: WorkingMemorySnapshotEntry | null;
  readonly constraints?: readonly WorkingMemorySnapshotEntry[];
  readonly decisions?: readonly WorkingMemorySnapshotEntry[];
  readonly facts?: readonly WorkingMemorySnapshotEntry[];
  readonly currentState?: WorkingMemorySnapshotEntry | null;
  readonly nextStep?: WorkingMemorySnapshotEntry | null;
  readonly abandonedPaths?: readonly WorkingMemorySnapshotEntry[];
  readonly keyObjects?: readonly WorkingMemorySnapshotEntry[];
}

export interface WorkingMemoryPromptSection {
  readonly scope: 'conversation' | 'agent';
  readonly agentId: number;
  readonly version: number;
  readonly snapshotUuid: string;
  readonly renderText: string;
  readonly tokenEstimate: number;
  readonly snapshotJson?: WorkingMemorySnapshotJson | null;
  readonly gmtCreate?: string;
}

export type WorkingMemoryData =
  | readonly WorkingMemoryPromptSection[]
  | readonly WorkingMemorySection[]
  | {
      readonly conversationId: number;
      readonly agentId?: number;
      readonly sections: readonly WorkingMemorySection[];
      readonly updatedAt?: string;
    };

export type MemoryWikiCompileStatus = 'empty' | 'running' | 'completed' | 'failed';
export type MemoryWikiCompileMode = 'full' | 'delta';

export interface InitializeConversationMemoryWikiResult {
  readonly conversationId: number;
  readonly agentId?: number;
  readonly status: MemoryWikiCompileStatus;
  readonly mode?: MemoryWikiCompileMode | null;
  readonly initialized?: boolean;
  readonly enqueuedJobs?: number;
  readonly consumedMessageCount?: number;
  readonly pageCount?: number;
  readonly error?: string;
}

export interface ConversationMemoryWikiStatus {
  readonly conversationId?: number;
  readonly agentId?: number;
  readonly status: 'not_initialized' | 'initializing' | 'ready' | 'failed' | MemoryWikiCompileStatus;
  readonly mode?: MemoryWikiCompileMode | null;
  readonly pageCount?: number;
  readonly totalJobs?: number;
  readonly pendingJobs?: number;
  readonly runningJobs?: number;
  readonly completedJobs?: number;
  readonly failedJobs?: number;
  readonly skippedJobs?: number;
  readonly progressPercent?: number;
  readonly canInitialize?: boolean;
  readonly updatedAt?: string;
}

export interface ConversationMemoryWikiPage {
  readonly pageUuid: string;
  readonly pageKey: string;
  readonly title: string;
  readonly pageType?: string;
  readonly scopeType?: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly importance?: number;
  readonly confidence?: number;
  readonly version?: number;
  readonly markdown?: string;
  readonly bodyMd?: string;
  readonly structuredJson?: Record<string, unknown> | null;
  readonly entities?: readonly unknown[];
  readonly evidenceRefs?: readonly unknown[];
  readonly updatedAt?: string;
  readonly gmtModified?: string | null;
}

export interface ConversationMemoryWikiPageListData {
  readonly list?: readonly ConversationMemoryWikiPage[];
  readonly pages?: readonly ConversationMemoryWikiPage[];
  readonly total?: number;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ConversationMemoryCompileStatus {
  readonly conversationId: number;
  readonly agentId?: number;
  readonly status: 'idle' | 'running' | 'completed' | 'failed';
  readonly consumedMessageCount?: number;
  readonly error?: string;
}
