import { createConversationStore } from '@peer-agent/conversation-store';
import {
  buildCompactionMarker,
  contextAccountingModelKey,
} from '@peer-agent/protocol';
import type { ContextAccountingSnapshot } from '@peer-agent/protocol';
import {
  createRestoredObservedContextAccountingSnapshot,
  latestObservedUsageFromMessages,
  projectConversationHistory,
} from '@peer-agent/runtime-core';
import { realpathSync } from 'node:fs';
import type { ModelMessage, RuntimeModelSelection } from '@peer-agent/runtime-node';

import type { AssistantSegment, ChatController, ChatMessage, ChatMessageImage, ChatSnapshot } from './chat-controller.ts';
import { normalizeTuiMode, type TuiMode } from './tui-mode.ts';

export interface TuiConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt?: string;
  readonly messageCount: number;
}

export interface TuiConversationRestore {
  readonly id: string;
  readonly mode: TuiMode;
  /** Complete UI transcript, including historical compaction boundaries. */
  readonly messages: readonly ChatMessage[];
  /** Active provider history after the latest shared compaction boundary. */
  readonly modelMessages?: readonly ModelMessage[];
  /** Latest cumulative summary admitted through System Context. */
  readonly continuityContext?: string;
  readonly modelSelection?: RuntimeModelSelection;
  readonly usage?: NonNullable<ChatSnapshot['usage']>;
  readonly contextSnapshot?: ContextAccountingSnapshot;
}

interface ConversationChangeEvent {
  readonly conversationId?: string;
  readonly writerPid?: number;
  readonly revision?: string;
}

interface ConversationStore {
  listConversations(params?: { status?: string }): readonly Record<string, unknown>[];
  listConversationsByWorkspace?(
    workspacePath: string | null | undefined,
    params?: { status?: string },
  ): readonly Record<string, unknown>[];
  getConversation(id: string): (Record<string, unknown> & { messages?: readonly Record<string, unknown>[] }) | null;
  createConversation(input?: { title?: string; workspacePath?: string; mode?: TuiMode }): { id: string };
  appendMessage(id: string, message: ChatMessage & { timestamp: number }): unknown;
  replaceMessages?(id: string, messages: readonly Record<string, unknown>[], options?: { allowEmpty?: boolean }): unknown;
  updateMode(id: string, mode: TuiMode): unknown;
  updateModelEffort(id: string, input: { effort: string; modelProviderId: string | null; model?: string }): unknown;
  updateContextSnapshot?(id: string, snapshot: ContextAccountingSnapshot): unknown;
  getLatestObservedUsage?(
    id: string,
    options?: { model?: string | null },
  ): { inputTokens: number; cacheReadTokens: number } | null;
  addUsage(id: string, usage: NonNullable<ChatSnapshot['usage']>): unknown;
  subscribeChanges?(listener: (event: ConversationChangeEvent) => void): () => void;
}

export interface TuiConversationPersistence {
  getConversationId(): string | undefined;
  ensureConversation(): string;
  listResumable(): readonly TuiConversationSummary[];
  loadConversation(id: string): TuiConversationRestore | null;
  resumeConversation(conversation: TuiConversationRestore): void;
  subscribeExternalChanges(listener: (conversationId: string) => void): () => void;
  syncSnapshot(snapshot: ChatSnapshot): void;
  syncModel(selection: RuntimeModelSelection): void;
  startNewConversation(mode: TuiMode): void;
}

export function resumeTuiConversation(
  controller: Pick<ChatController, 'getSnapshot' | 'restore'>,
  persistence: Pick<TuiConversationPersistence, 'resumeConversation'>,
  conversation: TuiConversationRestore,
): boolean {
  if (controller.getSnapshot().status !== 'idle') return false;
  persistence.resumeConversation(conversation);
  if (!controller.restore({
    ...conversation,
    contextAccounting: conversation.contextSnapshot,
  })) {
    throw new Error('Conversation restore invariant failed after the idle-state check.');
  }
  return true;
}

function storedToken(...values: readonly unknown[]): number | undefined {
  const value = values.find((candidate) =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0,
  );
  return typeof value === 'number' ? Math.floor(value) : undefined;
}

function storedUsage(value: unknown): NonNullable<ChatSnapshot['usage']> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = storedToken(usage.inputTokens, usage.input);
  const outputTokens = storedToken(usage.outputTokens, usage.output);
  const totalTokens = storedToken(usage.totalTokens);
  const cacheReadTokens = storedToken(usage.cacheReadTokens, usage.cacheRead);
  const cacheWriteTokens = storedToken(usage.cacheWriteTokens, usage.cacheWrite);
  if (![inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens]
    .some((tokens) => tokens !== undefined && tokens > 0)) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

function storedToolPresentation(value: unknown): ChatMessage['tool'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.capabilityId !== 'string' || !record.capabilityId.trim()) return undefined;
  const detailLines = Array.isArray(record.detailLines)
    ? record.detailLines.filter((line): line is string => typeof line === 'string')
    : [];
  const toolCallId = typeof record.toolCallId === 'string' && record.toolCallId.trim()
    ? record.toolCallId.trim()
    : undefined;
  const args = record.arguments;
  const arguments_ = args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : record.arguments === null
      ? null
      : undefined;
  const startedAt = typeof record.startedAt === 'number' && Number.isFinite(record.startedAt)
    ? record.startedAt
    : undefined;
  const completedAt = typeof record.completedAt === 'number' && Number.isFinite(record.completedAt)
    ? record.completedAt
    : undefined;
  const durationMs = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)
    ? Math.max(0, record.durationMs)
    : undefined;
  return {
    capabilityId: record.capabilityId,
    toolName: typeof record.toolName === 'string' ? record.toolName : record.capabilityId,
    argumentSummary: typeof record.argumentSummary === 'string' ? record.argumentSummary : '',
    status: (
      record.status === 'completed'
      || record.status === 'failed'
      || record.status === 'cancelled'
      || record.status === 'denied'
      || record.status === 'running'
      || record.status === 'unknown'
    ) ? record.status : 'unknown',
    detail: typeof record.detail === 'string' ? record.detail : '',
    detailLines,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(toolCallId ? { toolCallId } : {}),
    ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
  };
}

function storedCompactMeta(value: unknown): ChatMessage['compact'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.phase !== 'progress' && record.phase !== 'done') return undefined;
  return {
    phase: record.phase,
    ...(typeof record.percent === 'number' ? { percent: record.percent } : {}),
    ...(typeof record.beforeCount === 'number' ? { beforeCount: record.beforeCount } : {}),
    ...(typeof record.afterCount === 'number' ? { afterCount: record.afterCount } : {}),
    ...(typeof record.summarizedCount === 'number' ? { summarizedCount: record.summarizedCount } : {}),
    ...(typeof record.beforeTokens === 'number' ? { beforeTokens: record.beforeTokens } : {}),
    ...(typeof record.afterTokens === 'number' ? { afterTokens: record.afterTokens } : {}),
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
    ...(typeof record.handoffContent === 'string' ? { handoffContent: record.handoffContent } : {}),
    ...(typeof record.retainedUserCount === 'number' ? { retainedUserCount: record.retainedUserCount } : {}),
  };
}

function desktopToolSegment(tool: NonNullable<ChatMessage['tool']>): Record<string, unknown> {
  return {
    type: 'tool-call',
    tool: tool.capabilityId,
    displayName: tool.toolName,
    ...(tool.arguments && typeof tool.arguments === 'object' ? { args: tool.arguments } : {}),
    result: tool.detail || tool.status,
    ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}),
  };
}

function toolsFromMessage(message: ChatMessage): readonly NonNullable<ChatMessage['tool']>[] {
  if (message.tools && message.tools.length > 0) return message.tools;
  if (message.segments && message.segments.length > 0) {
    const fromSegments = message.segments
      .filter((segment): segment is Extract<AssistantSegment, { type: 'tool-call' }> => segment.type === 'tool-call')
      .map((segment) => segment.tool);
    if (fromSegments.length > 0) return fromSegments;
  }
  if (message.tool) return [message.tool];
  return [];
}

function desktopSegmentsForMessage(message: ChatMessage): Record<string, unknown>[] | undefined {
  const tools = toolsFromMessage(message);
  if (message.role === 'tool' && tools.length > 0) {
    // Legacy CLI rows: one role=tool message per call.
    return tools.map((tool) => desktopToolSegment(tool));
  }
  if (message.role !== 'assistant') return undefined;

  // Prefer event-order segments when the runtime already built a timeline.
  if (message.segments && message.segments.length > 0) {
    const segments: Record<string, unknown>[] = [];
    for (const segment of message.segments) {
      if (segment.type === 'thinking') {
        if (segment.content.trim()) {
          segments.push({ type: 'thinking', content: segment.content });
        }
        continue;
      }
      if (segment.type === 'tool-call') {
        segments.push(desktopToolSegment(segment.tool));
        continue;
      }
      if (segment.type === 'text' && segment.content) {
        segments.push({ type: 'text', content: segment.content });
      }
    }
    return segments.length > 0 ? segments : undefined;
  }

  // Legacy fallback: thinking bucket + tools[] + text (no interleaving preserved).
  if (!message.thinkingContent && tools.length === 0) return undefined;

  const segments: Record<string, unknown>[] = [];
  if (message.thinkingContent) {
    segments.push({ type: 'thinking', content: message.thinkingContent });
  }
  for (const tool of tools) {
    segments.push(desktopToolSegment(tool));
  }
  if (message.content) {
    segments.push({ type: 'text', content: message.content });
  }
  return segments.length > 0 ? segments : undefined;
}


function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const base64 = dataUrl.slice(comma + 1);
  // base64 length to approximate decoded bytes; padding-aware.
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function extensionForMime(mimeType: string | undefined): string {
  switch ((mimeType ?? '').toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    case 'image/tiff':
      return 'tiff';
    case 'image/heic':
      return 'heic';
    case 'image/heif':
      return 'heif';
    case 'image/avif':
      return 'avif';
    case 'image/png':
    default:
      return 'png';
  }
}

/**
 * Map TUI runtime images into Desktop-readable chat attachments.
 * Desktop loads history via `message.attachments[].dataUrl`.
 */
function desktopAttachmentsFromImages(
  messageId: string,
  images: readonly ChatMessageImage[] | undefined,
): readonly Record<string, unknown>[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images
    .filter((image) => typeof image.url === 'string' && image.url.length > 0)
    .map((image, index) => {
      const mimeType = image.mimeType || 'image/png';
      const ext = extensionForMime(mimeType);
      return {
        id: `${messageId}-image-${index + 1}`,
        name: `image-${index + 1}.${ext}`,
        mimeType,
        size: dataUrlByteLength(image.url),
        kind: 'image' as const,
        dataUrl: image.url,
      };
    });
}

function imagesFromStoredAttachments(value: Record<string, unknown>): readonly ChatMessageImage[] | undefined {
  const attachments = Array.isArray(value.attachments) ? value.attachments : null;
  if (attachments) {
    const images = attachments
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        if (record.kind !== 'image') return null;
        const dataUrl = typeof record.dataUrl === 'string' ? record.dataUrl : '';
        if (!dataUrl) return null;
        return {
          url: dataUrl,
          ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
        } satisfies ChatMessageImage;
      })
      .filter((image): image is ChatMessageImage => Boolean(image));
    if (images.length > 0) return images;
  }

  const legacy = Array.isArray(value.images) ? value.images : null;
  if (!legacy) return undefined;
  const images = legacy
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const url = typeof record.url === 'string' ? record.url : '';
      if (!url) return null;
      return {
        url,
        ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
        ...(typeof record.width === 'number' ? { width: record.width } : {}),
        ...(typeof record.height === 'number' ? { height: record.height } : {}),
      } satisfies ChatMessageImage;
    })
    .filter((image): image is ChatMessageImage => Boolean(image));
  return images.length > 0 ? images : undefined;
}

function toolsFromStored(value: Record<string, unknown>): {
  tools?: readonly NonNullable<ChatMessage['tool']>[];
  tool?: NonNullable<ChatMessage['tool']>;
  thinkingContent?: string;
  segments?: readonly AssistantSegment[];
} {
  const tools: NonNullable<ChatMessage['tool']>[] = [];
  let thinkingContent: string | undefined;
  const segments: AssistantSegment[] = [];

  if (Array.isArray(value.tools)) {
    for (const item of value.tools) {
      if (!item || typeof item !== 'object') continue;
      const tool = storedToolPresentation(item as Record<string, unknown>);
      if (tool) tools.push(tool);
    }
  }

  if (Array.isArray(value.segments)) {
    for (const segment of value.segments) {
      if (!segment || typeof segment !== 'object') continue;
      const record = segment as Record<string, unknown>;
      if (record.type === 'thinking' && typeof record.content === 'string' && record.content.trim()) {
        thinkingContent = `${thinkingContent ?? ''}${record.content}`;
        segments.push({ type: 'thinking', content: record.content });
        continue;
      }
      if (record.type === 'text' && typeof record.content === 'string' && record.content) {
        segments.push({ type: 'text', content: record.content });
        continue;
      }
      if (record.type !== 'tool-call') continue;
      const capabilityId = typeof record.tool === 'string' ? record.tool : '';
      if (!capabilityId) continue;
      const tool = {
        capabilityId,
        toolName: typeof record.displayName === 'string' && record.displayName.trim()
          ? record.displayName
          : capabilityId,
        argumentSummary: '',
        status: 'completed' as const,
        detail: typeof record.result === 'string' ? record.result : 'completed',
        detailLines: typeof record.result === 'string' && record.result.trim()
          ? [record.result]
          : ['completed'],
        ...(record.args && typeof record.args === 'object' && !Array.isArray(record.args)
          ? { arguments: record.args as Record<string, unknown> }
          : {}),
        ...(typeof record.toolCallId === 'string' ? { toolCallId: record.toolCallId } : {}),
      };
      tools.push(tool);
      segments.push({ type: 'tool-call', tool });
    }
  }

  const single = storedToolPresentation(value.tool);
  if (tools.length === 0 && single) tools.push(single);

  // Legacy stored rows without ordered segments: reconstruct thinking→tools→text
  // only when structured parts exist. Pure text assistants stay segment-free.
  // Never invent segments for user/system rows.
  if (
    segments.length === 0
    && (value.role === 'assistant' || value.role === 'tool')
    && (thinkingContent || tools.length > 0)
  ) {
    if (thinkingContent) segments.push({ type: 'thinking', content: thinkingContent });
    for (const tool of tools) segments.push({ type: 'tool-call', tool });
    if (typeof value.content === 'string' && value.content) {
      segments.push({ type: 'text', content: value.content });
    }
  }

  return {
    ...(tools.length > 0 ? { tools, tool: tools[tools.length - 1] } : single ? { tool: single } : {}),
    ...(thinkingContent ? { thinkingContent } : {}),
    ...(segments.length > 0 ? { segments } : {}),
  };
}

function compactionRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function storedCompactionCard(value: Record<string, unknown>): ChatMessage['compact'] | undefined {
  const record = compactionRecord(value._compaction);
  if (!record) return undefined;
  const originalMessageCount = storedToken(record.originalMessageCount) ?? 0;
  const afterCount = storedToken(record.afterMessageCount, record.keptMessageCount) ?? 0;
  return {
    phase: 'done',
    beforeCount: originalMessageCount,
    afterCount,
    summarizedCount: Math.max(0, originalMessageCount - afterCount),
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
    handoffContent: value.content as string,
  };
}

function activeStoredContext(messages: readonly Record<string, unknown>[]): {
  readonly modelMessages: readonly ModelMessage[];
  readonly continuityContext?: string;
} {
  const projected = projectConversationHistory(messages);
  return {
    modelMessages: projected.messages as readonly ModelMessage[],
    ...(projected.continuityContext
      ? { continuityContext: projected.continuityContext }
      : {}),
  };
}

function storedMessage(value: Record<string, unknown>, index: number): ChatMessage | null {
  if (!['user', 'assistant', 'tool', 'system'].includes(String(value.role)) || typeof value.content !== 'string') return null;
  const usage = storedUsage(value.usage);
  const restoredTools = toolsFromStored(value);
  const compact = storedCompactMeta(value.compact) ?? storedCompactionCard(value);
  const images = imagesFromStoredAttachments(value);
  // Do not restore in-flight compact progress rows.
  if (compact?.phase === 'progress' || value.pending === true && String(value.role) === 'system') return null;
  return {
    id: typeof value.id === 'string' ? value.id : `restored-${index}`,
    role: compactionRecord(value._compaction) ? 'system' : value.role as ChatMessage['role'],
    content: value.content,
    ...(images ? { images } : {}),
    ...(usage ? { usage } : {}),
    ...restoredTools,
    ...(compact ? { compact } : {}),
    ...(value.interrupted === true ? { interrupted: true } : {}),
  };
}

function restoredProviderUsage(
  messages: readonly ChatMessage[],
): NonNullable<ChatSnapshot['usage']> | undefined {
  return [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.usage)?.usage;
}

function restoredSelection(value: Record<string, unknown>): RuntimeModelSelection | undefined {
  if (
    typeof value.modelProviderId !== 'string'
    || typeof value.model !== 'string'
    || typeof value.effort !== 'string'
  ) return undefined;
  const binding = value.modelProviderId.trim();
  const modelId = value.model.trim();
  if (!binding || !modelId) return undefined;
  const legacySuffix = `::${modelId}`;
  const providerId = binding.endsWith(legacySuffix)
    ? binding.slice(0, -legacySuffix.length)
    : binding;
  if (!providerId) return undefined;
  return {
    providerId,
    modelId,
    reasoningEffort: value.effort as RuntimeModelSelection['reasoningEffort'],
  };
}

function modelProviderId(selection: RuntimeModelSelection): string {
  return selection.providerId;
}

function normalizeWorkspacePath(workspacePath: string): string {
  try {
    return realpathSync(workspacePath);
  } catch {
    return workspacePath;
  }
}

export function createTuiConversationPersistence(options: {
  readonly workspacePath: string;
  readonly initialMode: TuiMode;
  readonly initialModel: RuntimeModelSelection;
  readonly getContextWindow?: (selection: RuntimeModelSelection) => number | undefined;
  readonly store?: ConversationStore;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}): TuiConversationPersistence {
  const store: ConversationStore = options.store ?? createConversationStore() as ConversationStore;
  const now = options.now ?? Date.now;
  const reportError = options.onError ?? (() => {});
  const workspacePath = normalizeWorkspacePath(options.workspacePath);
  let conversationId: string | undefined;
  let mode = options.initialMode;
  let model = options.initialModel;
  let persistedMessageIds = new Set<string>();
  let usageMessageIds = new Set<string>();

  function ensureConversation(): string {
    if (conversationId) return conversationId;
    const conversation = store.createConversation({
      workspacePath,
      mode,
    });
    conversationId = conversation.id;
    store.updateModelEffort(conversationId, {
      effort: model.reasoningEffort,
      modelProviderId: modelProviderId(model),
      model: model.modelId,
    });
    return conversationId;
  }

  return {
    getConversationId: () => conversationId,
    ensureConversation,
    listResumable() {
      try {
        const conversations = store.listConversationsByWorkspace
          ? store.listConversationsByWorkspace(workspacePath, { status: 'active' })
          : store.listConversations({ status: 'active' });
        return conversations
          .filter((item) => item.id !== conversationId && Number(item.messageCount ?? 0) > 0)
          .map((item) => ({
            id: String(item.id),
            title: typeof item.title === 'string' && item.title.trim() ? item.title : 'Untitled conversation',
            updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : undefined,
            messageCount: Number(item.messageCount ?? 0),
          }));
      } catch (error) {
        reportError(error);
        return [];
      }
    },
    loadConversation(id) {
      try {
        const stored = store.getConversation(id);
        if (!stored || !Array.isArray(stored.messages)) return null;
        const storedMessages = stored.messages as Record<string, unknown>[];
        const messages = storedMessages
          .map((message, index) => storedMessage(message, index))
          .filter((message): message is ChatMessage => Boolean(message));
        if (messages.length === 0) return null;
        const activeContext = activeStoredContext(storedMessages);
        const providerUsage = restoredProviderUsage(messages);
        const modelSelection = restoredSelection(stored);
        const observedUsage = latestObservedUsageFromMessages(storedMessages)
          ?? store.getLatestObservedUsage?.(id, { model: modelSelection?.modelId });
        const persistedContextSnapshot = stored.contextSnapshot
          && typeof stored.contextSnapshot === 'object'
          && (stored.contextSnapshot as { version?: unknown }).version === 1
          && (stored.contextSnapshot as { conversationId?: unknown }).conversationId === id
          ? stored.contextSnapshot as unknown as ContextAccountingSnapshot
          : undefined;
        const contentRevision = Number.isSafeInteger(Number(stored.contentRevision))
          ? Math.max(0, Number(stored.contentRevision))
          : 0;
        const contextSnapshot = persistedContextSnapshot ?? (
          modelSelection && observedUsage
            ? createRestoredObservedContextAccountingSnapshot({
                identity: {
                  conversationId: id,
                  contentRevision,
                  modelKey: contextAccountingModelKey(
                    modelSelection.providerId,
                    modelSelection.modelId,
                  ),
                },
                contextWindow: options.getContextWindow?.(modelSelection),
                countCapability: { kind: 'observed_usage_only' },
                usage: observedUsage,
                pendingUncountedChanges: true,
                now: now(),
              })
            : undefined
        );
        return {
          id,
          mode: normalizeTuiMode(stored.mode, 'chat'),
          messages,
          modelMessages: activeContext.modelMessages,
          ...(activeContext.continuityContext
            ? { continuityContext: activeContext.continuityContext }
            : {}),
          ...(modelSelection ? { modelSelection } : {}),
          ...(providerUsage ? { usage: providerUsage } : {}),
          ...(contextSnapshot ? { contextSnapshot } : {}),
        };
      } catch (error) {
        reportError(error);
        return null;
      }
    },
    resumeConversation(conversation) {
      conversationId = conversation.id;
      mode = conversation.mode;
      persistedMessageIds = new Set(conversation.messages.map((message) => message.id));
      usageMessageIds = new Set();
      if (conversation.modelSelection) model = conversation.modelSelection;
    },
    subscribeExternalChanges(listener) {
      if (!store.subscribeChanges) return () => {};
      return store.subscribeChanges((event) => {
        if (event.writerPid === process.pid) return;
        const currentId = conversationId;
        if (!currentId || event.conversationId !== currentId) return;
        listener(currentId);
      });
    },
    syncSnapshot(snapshot) {
      try {
        mode = snapshot.mode;
        const stableMessages = snapshot.messages.filter((message) => !message.pending);
        if (stableMessages.length === 0 && !conversationId) return;

        const id = ensureConversation();
        store.updateMode(id, mode);

        const compactMessage = [...stableMessages]
          .reverse()
          .find((message) => message.compact?.phase === 'done' && message.compact.handoffContent);
        const compact = compactMessage?.compact;
        const newMessages = stableMessages.filter((message) => (
          !persistedMessageIds.has(message.id) && message.id !== compactMessage?.id
        ));
        const completedAssistant = snapshot.status === 'idle'
          ? [...newMessages].reverse().find((message) => message.role === 'assistant')
          : undefined;
        for (const message of newMessages) {
          // Desktop replay contract: assistant turns carry tool-call segments so
          // history load can render one "Processed N tools" summary instead of N rows.
          const segments = desktopSegmentsForMessage(message);
          const attachments = desktopAttachmentsFromImages(message.id, message.images);
          // Persist Desktop-compatible attachments for image messages.
          // Keep runtime `images` for in-memory TUI state, but write `attachments` for Desktop.
          const { images: _images, ...messageWithoutImages } = message;
          store.appendMessage(id, {
            ...messageWithoutImages,
            ...(attachments ? { attachments } : {}),
            ...(snapshot.usage && message.id === completedAssistant?.id
              ? { usage: snapshot.usage }
              : {}),
            ...(segments ? { segments } : {}),
            timestamp: now(),
          } as ChatMessage & { timestamp: number; attachments?: readonly Record<string, unknown>[] });
          persistedMessageIds.add(message.id);
        }

        // Rewrite only after ordinary messages are durable, so first-sync and
        // incremental compaction locate the same complete user-turn boundary.
        if (store.replaceMessages) {
          const stored = store.getConversation(id);
          const storedMessages = Array.isArray(stored?.messages)
            ? [...stored.messages] as Record<string, unknown>[]
            : [];
          let changed = false;
          let rewritten = storedMessages.map((message) => {
            const messageId = typeof message.id === 'string' ? message.id : '';
            if (!messageId || message.interrupted !== true) return message;
            const live = stableMessages.find((item) => item.id === messageId);
            if (!live || live.interrupted === true) return message;
            changed = true;
            const { interrupted: _removed, ...rest } = message;
            return rest;
          });
          const alreadyPersisted = compactMessage
            ? rewritten.some((message) => message.id === compactMessage.id && compactionRecord(message._compaction))
            : false;
          if (compactMessage && compact && !alreadyPersisted) {
            const retainedUserCount = Math.max(0, Math.floor(compact.retainedUserCount ?? 0));
            const userIndexes = rewritten
              .map((message, index) => ({ message, index }))
              .filter(({ message }) => message.role === 'user' && !compactionRecord(message._compaction));
            const insertionIndex = retainedUserCount > 0 && userIndexes.length >= retainedUserCount
              ? userIndexes[userIndexes.length - retainedUserCount]!.index
              : rewritten.length;
            const marker = {
              id: compactMessage.id,
              role: 'user',
              content: compact.handoffContent,
              timestamp: now(),
              // 共享 marker 形状经 protocol buildCompactionMarker 产出(23 号治理文档不变式 3);
              // method 取真实级联结果(llm/structured/fallback_drop),不再硬编码 structural。
              _compaction: buildCompactionMarker({
                method: compact.method,
                originalMessageCount: compact.beforeCount ?? 0,
                previousMessageCount: 0,
                deltaMessageCount: compact.summarizedCount ?? 0,
                beforeTokens: compact.beforeTokens ?? 0,
                afterTokens: compact.afterTokens ?? 0,
                summary: compact.summary ?? '',
                decisionAnchors: [],
              }),
            };
            rewritten = [
              ...rewritten.slice(0, insertionIndex),
              marker,
              ...rewritten.slice(insertionIndex),
            ];
            changed = true;
          }
          if (changed) {
            const replaced = store.replaceMessages(id, rewritten);
            if (replaced === null) {
              throw new Error(`Failed to persist shared compaction marker for ${id}`);
            }
            if (compactMessage && !alreadyPersisted) {
              persistedMessageIds.add(compactMessage.id);
            }
          }
        }

        if (snapshot.status === 'idle' && snapshot.usage && completedAssistant && !usageMessageIds.has(completedAssistant.id)) {
          store.addUsage(id, snapshot.usage);
          usageMessageIds.add(completedAssistant.id);
        }

        if (snapshot.status === 'idle' && snapshot.contextAccounting && store.updateContextSnapshot) {
          store.updateContextSnapshot(id, snapshot.contextAccounting);
        }
      } catch (error) {
        reportError(error);
      }
    },
    syncModel(selection) {
      model = selection;
      if (!conversationId) return;
      try {
        store.updateModelEffort(conversationId, {
          effort: selection.reasoningEffort,
          modelProviderId: modelProviderId(selection),
          model: selection.modelId,
        });
      } catch (error) {
        reportError(error);
      }
    },
    startNewConversation(nextMode) {
      conversationId = undefined;
      mode = nextMode;
      persistedMessageIds = new Set();
      usageMessageIds = new Set();
    },
  };
}
