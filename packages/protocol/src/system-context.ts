export type AttachmentContextKind = 'image' | 'text' | 'unsupported';

export type AttachmentContextTransport =
  | 'provider_image_part'
  | 'user_text_part'
  | 'metadata_only'
  | string;

export interface AttachmentContextItem {
  readonly id?: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly kind: AttachmentContextKind;
  readonly contentIncluded: boolean;
  readonly transport: AttachmentContextTransport;
}

export interface ContinuityContextItem {
  readonly id?: string;
  readonly method: string;
  readonly originalMessageCount: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly summary: string;
  readonly content?: string;
}

export interface ConfigInstructionContextItem {
  readonly id?: string;
  readonly title?: string;
  readonly content: string;
  readonly priority?: number;
  readonly source?: string;
}

export interface ContextExtensionItem {
  readonly id: string;
  readonly title?: string;
  readonly content: string;
  readonly layer?: 'L3_INSTRUCTIONS' | 'L4_CAPABILITIES' | 'L5_TOOL_RULES' | string;
  readonly priority?: number;
  readonly sourceKind?: 'plugin' | 'skill' | 'mcp' | 'runtime' | string;
  readonly trust?: 'builtin' | 'runtime' | 'workspace' | 'user' | 'extension' | string;
}

export interface ChatProviderMessage {
  readonly role: string;
  readonly content: unknown;
}

export interface ChatSendRequest {
  readonly messages: readonly ChatProviderMessage[];
  readonly streamId: string;
  readonly effort?: string;
  readonly conversationId?: string;
  readonly attachmentContext?: readonly AttachmentContextItem[];
  readonly continuityContext?: readonly ContinuityContextItem[];
  readonly configInstructions?: readonly ConfigInstructionContextItem[];
  readonly contextExtensions?: readonly ContextExtensionItem[];
}

export interface PromptSnapshotSectionRef {
  readonly id: string;
  readonly layer: string;
  readonly checksum: string;
  readonly source?: Record<string, unknown>;
}

export interface PromptSnapshotIndexEntry {
  readonly id: string;
  readonly contextSnapshotId: string;
  readonly createdAt: string;
  readonly streamId: string | null;
  readonly conversationId: string | null;
  readonly workspacePath: string | null;
  readonly provider: string | null;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly mode: string | null;
  readonly effort: string | null;
  readonly renderedHash: string;
  readonly sectionRefs: readonly PromptSnapshotSectionRef[];
  readonly baselineId?: string;
  readonly baselineReason?: string;
  readonly contextEpochId?: string;
}

export interface PromptSnapshotRecord extends PromptSnapshotIndexEntry {
  readonly context: {
    readonly version: number;
    readonly rendered: string;
    readonly sections: readonly Record<string, unknown>[];
    readonly snapshot: Record<string, unknown>;
  };
}

export interface PromptBaselineRecord {
  readonly baselineId: string;
  readonly contextEpochId: string;
  readonly reason: string;
  readonly promptRecordId: string;
  readonly contextSnapshotId: string;
  readonly createdAt: string;
  readonly conversationId: string | null;
  readonly workspacePath: string | null;
  readonly provider: string | null;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly mode: string | null;
  readonly effort: string | null;
  readonly renderedHash: string;
  readonly sectionRefs: readonly PromptSnapshotSectionRef[];
}

export interface PromptContextEpochRecord {
  readonly contextEpochId: string;
  readonly reason: string;
  readonly baselineId: string;
  readonly promptRecordId: string;
  readonly contextSnapshotId: string;
  readonly createdAt: string;
  readonly replacesContextEpochId: string | null;
  readonly conversationId: string | null;
  readonly workspacePath: string | null;
  readonly provider: string | null;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly mode: string | null;
  readonly effort: string | null;
  readonly renderedHash: string;
  readonly sectionRefs: readonly PromptSnapshotSectionRef[];
}

export type PromptContextEpochEventType =
  | 'epoch_created'
  | 'epoch_replaced'
  | 'snapshot_anchored';

export interface PromptContextEpochEventRecord {
  readonly eventId: string;
  readonly eventType: PromptContextEpochEventType;
  readonly occurredAt: string;
  readonly contextEpochId: string;
  readonly previousContextEpochId: string | null;
  readonly reason: string | null;
  readonly baselineId: string | null;
  readonly promptRecordId: string;
  readonly contextSnapshotId: string;
  readonly conversationId: string | null;
  readonly workspacePath: string | null;
  readonly provider: string | null;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly mode: string | null;
  readonly effort: string | null;
  readonly renderedHash: string;
}
