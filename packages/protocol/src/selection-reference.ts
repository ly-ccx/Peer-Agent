/** UTF-16 offsets into the persisted message content; code-point length is limited by the host. */
export interface SelectionRange {
  readonly conversationId: string;
  readonly messageId: string;
  readonly blockId: 'content';
  readonly revision: number;
  readonly start: number;
  readonly end: number;
  readonly exactText: string;
  readonly sourceTextHash: string;
}

export interface SelectionReference {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceConversationId: string;
  readonly sourceMessageId: string;
  readonly blockId: string;
  readonly sourceRevision: number;
  readonly sourceRole: 'user' | 'assistant';
  readonly start: number;
  readonly end: number;
  readonly exactText: string;
  readonly textHash: string;
  readonly sourceTextHash: string;
}

export interface SelectionDraft {
  readonly text: string;
  readonly references: readonly SelectionReference[];
}
export interface SelectionOrigin {
  readonly schemaVersion: 1;
  readonly parentConversationId: string;
  readonly reference: SelectionReference;
  readonly snapshotId: string;
  readonly createdAt: string;
}
export interface SelectionChildSession {
  readonly id: string;
  readonly title: string;
  readonly contentRevision: number;
  readonly selectionOrigin: SelectionOrigin;
  readonly selectionDraft: SelectionDraft;
}
export interface SelectionChildSummary {
  readonly id: string;
  readonly title: string;
  readonly sourceReference: SelectionReference;
  readonly lifecycle: 'draft' | 'active' | 'archived';
  readonly runState: 'idle' | 'running' | 'error' | 'unknown';
  readonly contentRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly hasDraft: boolean;
}
export interface SelectionChildrenPage {
  readonly items: readonly SelectionChildSummary[];
  readonly total: number;
  readonly nextOffset: number | null;
}
export interface SelectionChildRead {
  readonly childId: string;
  readonly contentRevision: number;
  readonly messages: readonly { id: string; role: 'user' | 'assistant'; content: string; contentTruncated?: boolean }[];
  readonly truncated: boolean;
  readonly characterCount: number;
  readonly readAt: string;
  readonly runState: SelectionChildSummary['runState'];
}
