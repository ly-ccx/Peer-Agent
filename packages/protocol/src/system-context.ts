export type AttachmentContextKind = 'image' | 'text' | 'unsupported';

export type AttachmentContextTransport =
  | 'provider_image_part'
  | 'user_text_part'
  | 'metadata_only'
  | string;

/**
 * 全局「兜底多模态模型」配置。
 * 主模型不支持 vision 时，可先用该模型识别本轮新图，再静默注入文本给主模型。
 * providerId 指向 listProviders() 的复合 id；null/缺省表示未配置。
 */
export interface FallbackVisionModelSettings {
  readonly providerId?: string | null;
}

export interface AttachmentContextItem {
  readonly id?: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly kind: AttachmentContextKind;
  readonly contentIncluded: boolean;
  readonly transport: AttachmentContextTransport;
}

export type ContextAttachmentSourceKind =
  | 'user_upload'
  | 'clipboard'
  | 'skill'
  | 'memory'
  | 'hook'
  | 'mcp'
  | 'runtime'
  | string;

export type ContextAttachmentScope = 'turn' | 'conversation' | 'workspace' | 'session' | string;

export type ContextAttachmentLifecycle = 'ephemeral' | 'durable_ref' | 'evidence_ref' | string;

export interface ContextAttachmentItem extends AttachmentContextItem {
  readonly sourceKind?: ContextAttachmentSourceKind;
  readonly scope?: ContextAttachmentScope;
  readonly lifecycle?: ContextAttachmentLifecycle;
  readonly contentRef?: string;
}

export type RuntimeReminderKind =
  | 'mode'
  | 'provider'
  | 'permission'
  | 'continuity'
  | 'attachment'
  | 'runtime'
  | string;

export type RuntimeReminderScope = 'turn' | 'conversation' | 'workspace' | 'session' | string;

export interface RuntimeReminderItem {
  readonly id: string;
  readonly title?: string;
  readonly content: string;
  readonly kind?: RuntimeReminderKind;
  readonly scope?: RuntimeReminderScope;
  readonly layer?: 'L2_RUNTIME' | 'L5_TOOL_RULES' | 'L6_MODE_REMINDER' | 'L7_CONTINUITY' | string;
  readonly priority?: number;
  readonly sourceKind?: 'runtime' | 'system' | 'plugin' | 'skill' | 'mcp' | string;
  readonly trust?: 'builtin' | 'runtime' | 'workspace' | 'user' | 'extension' | string;
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
  /**
   * @deprecated Desktop Main projects canonical history from conversationId.
   * Kept optional only for non-persisted/legacy callers during migration.
   */
  readonly messages?: readonly ChatProviderMessage[];
  readonly streamId: string;
  /**
   * 助手消息的持久化主键（renderer 在发送前已 append 的空 assistant 占位消息 id）。
   * 主进程据此把累积的正文/segments 落盘到 conversationStore，无需依赖 renderer
   * 在终态事件时回写——这是「正文持久化真值下沉主进程」的链路锚点。
   */
  readonly assistantMessageId?: string;
  readonly effort?: string;
  readonly mode?: string;
  readonly conversationId?: string;
  /**
   * 会话级绑定的模型 provider 复合 id（groupId::modelId）。渲染端从会话 meta 透传，
   * 主进程据此把该 provider 排为本轮首选；若已失效则回退全局默认（强绑定回退）。
   * 缺省时主进程会按 conversationId 从 conversation-store 兜底解析。
   */
  readonly modelProviderId?: string | null;
  /**
   * 渲染端当前活跃工作区路径（B2 兜底通道）。仅在主进程无法按 conversationId 从
   * conversation-store 解析到会话绑定的 workspacePath 时，作为兜底/校验来源使用，
   * 不作为运行根目录的主真值。详见 llm-chat-service.resolveRunWorkspacePath。
   */
  readonly workspacePath?: string | null;
  readonly contextAttachments?: readonly ContextAttachmentItem[];
  readonly runtimeReminders?: readonly RuntimeReminderItem[];
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
