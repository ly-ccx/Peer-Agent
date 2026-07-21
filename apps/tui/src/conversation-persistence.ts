import { createConversationStore } from '@peer-agent/conversation-store';
import type { RuntimeModelSelection } from '@peer-agent/runtime-node';

import type { ChatController, ChatMessage, ChatMessageImage, ChatSnapshot } from './chat-controller.ts';
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
  readonly messages: readonly ChatMessage[];
  readonly modelSelection?: RuntimeModelSelection;
  readonly usage?: NonNullable<ChatSnapshot['usage']>;
}

interface ConversationStore {
  listConversations(params?: { status?: string }): readonly Record<string, unknown>[];
  getConversation(id: string): (Record<string, unknown> & { messages?: readonly Record<string, unknown>[] }) | null;
  createConversation(input?: { title?: string; workspacePath?: string; mode?: TuiMode }): { id: string };
  appendMessage(id: string, message: ChatMessage & { timestamp: number }): unknown;
  updateMode(id: string, mode: TuiMode): unknown;
  updateModelEffort(id: string, input: { effort: string; modelProviderId: string | null }): unknown;
  addUsage(id: string, usage: NonNullable<ChatSnapshot['usage']>): unknown;
}

export interface TuiConversationPersistence {
  getConversationId(): string | undefined;
  listResumable(): readonly TuiConversationSummary[];
  loadConversation(id: string): TuiConversationRestore | null;
  resumeConversation(conversation: TuiConversationRestore): void;
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
  if (!controller.restore(conversation)) {
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

  // Only emit segments when the assistant turn has structured parts
  // (thinking / tools). Plain text-only assistants stay segment-free.
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
} {
  const tools: NonNullable<ChatMessage['tool']>[] = [];
  let thinkingContent: string | undefined;

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
        thinkingContent = record.content;
        continue;
      }
      if (record.type !== 'tool-call') continue;
      const capabilityId = typeof record.tool === 'string' ? record.tool : '';
      if (!capabilityId) continue;
      tools.push({
        capabilityId,
        toolName: typeof record.displayName === 'string' && record.displayName.trim()
          ? record.displayName
          : capabilityId,
        argumentSummary: '',
        status: 'completed',
        detail: typeof record.result === 'string' ? record.result : 'completed',
        detailLines: typeof record.result === 'string' && record.result.trim()
          ? [record.result]
          : ['completed'],
        ...(record.args && typeof record.args === 'object' && !Array.isArray(record.args)
          ? { arguments: record.args as Record<string, unknown> }
          : {}),
        ...(typeof record.toolCallId === 'string' ? { toolCallId: record.toolCallId } : {}),
      });
    }
  }

  const single = storedToolPresentation(value.tool);
  if (tools.length === 0 && single) tools.push(single);

  return {
    ...(tools.length > 0 ? { tools, tool: tools[tools.length - 1] } : single ? { tool: single } : {}),
    ...(thinkingContent ? { thinkingContent } : {}),
  };
}

function storedMessage(value: Record<string, unknown>, index: number): ChatMessage | null {
  if (!['user', 'assistant', 'tool', 'system'].includes(String(value.role)) || typeof value.content !== 'string') return null;
  const usage = storedUsage(value.usage);
  const restoredTools = toolsFromStored(value);
  const compact = storedCompactMeta(value.compact);
  const images = imagesFromStoredAttachments(value);
  // Do not restore in-flight compact progress rows.
  if (compact?.phase === 'progress' || value.pending === true && String(value.role) === 'system') return null;
  return {
    id: typeof value.id === 'string' ? value.id : `restored-${index}`,
    role: value.role as ChatMessage['role'],
    content: value.content,
    ...(images ? { images } : {}),
    ...(usage ? { usage } : {}),
    ...restoredTools,
    ...(compact ? { compact } : {}),
    ...(value.interrupted === true ? { interrupted: true } : {}),
  };
}

const CJK_REGEX =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g;

function estimateTextTokens(text: string): number {
  const cjkCount = text.match(CJK_REGEX)?.length ?? 0;
  return Math.ceil(cjkCount / 1.7 + (text.length - cjkCount) / 4);
}

function restoredContextUsage(
  messages: readonly ChatMessage[],
): NonNullable<ChatSnapshot['usage']> | undefined {
  const providerUsage = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.usage)?.usage;
  if (providerUsage) return providerUsage;
  const inputTokens = messages.reduce(
    (total, message) => total + 10 + estimateTextTokens(message.content),
    0,
  );
  return inputTokens > 0 ? { inputTokens, totalTokens: inputTokens } : undefined;
}

function restoredSelection(value: Record<string, unknown>): RuntimeModelSelection | undefined {
  if (typeof value.modelProviderId !== 'string' || typeof value.effort !== 'string') return undefined;
  const separator = value.modelProviderId.indexOf('::');
  if (separator <= 0 || separator === value.modelProviderId.length - 2) return undefined;
  return {
    providerId: value.modelProviderId.slice(0, separator),
    modelId: value.modelProviderId.slice(separator + 2),
    reasoningEffort: value.effort as RuntimeModelSelection['reasoningEffort'],
  };
}

function modelProviderId(selection: RuntimeModelSelection): string {
  return `${selection.providerId}::${selection.modelId}`;
}

export function createTuiConversationPersistence(options: {
  readonly workspacePath: string;
  readonly initialMode: TuiMode;
  readonly initialModel: RuntimeModelSelection;
  readonly store?: ConversationStore;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}): TuiConversationPersistence {
  const store: ConversationStore = options.store ?? createConversationStore() as ConversationStore;
  const now = options.now ?? Date.now;
  const reportError = options.onError ?? (() => {});
  let conversationId: string | undefined;
  let mode = options.initialMode;
  let model = options.initialModel;
  let persistedMessageIds = new Set<string>();
  let usageMessageIds = new Set<string>();

  function ensureConversation(): string {
    if (conversationId) return conversationId;
    const conversation = store.createConversation({
      workspacePath: options.workspacePath,
      mode,
    });
    conversationId = conversation.id;
    store.updateModelEffort(conversationId, {
      effort: model.reasoningEffort,
      modelProviderId: modelProviderId(model),
    });
    return conversationId;
  }

  return {
    getConversationId: () => conversationId,
    listResumable() {
      try {
        return store.listConversations({ status: 'active' })
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
        const messages = stored.messages
          .map((message, index) => storedMessage(message, index))
          .filter((message): message is ChatMessage => Boolean(message));
        if (messages.length === 0) return null;
        return {
          id,
          mode: normalizeTuiMode(stored.mode, 'chat'),
          messages,
          modelSelection: restoredSelection(stored),
          usage: restoredContextUsage(messages),
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
    syncSnapshot(snapshot) {
      try {
        mode = snapshot.mode;
        const stableMessages = snapshot.messages.filter((message) => !message.pending);
        if (stableMessages.length === 0 && !conversationId) return;

        const id = ensureConversation();
        store.updateMode(id, mode);
        const newMessages = stableMessages.filter((message) => !persistedMessageIds.has(message.id));
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

        if (snapshot.status === 'idle' && snapshot.usage && completedAssistant && !usageMessageIds.has(completedAssistant.id)) {
          store.addUsage(id, snapshot.usage);
          usageMessageIds.add(completedAssistant.id);
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
