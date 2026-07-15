import { createConversationStore } from '@peer-agent/conversation-store';
import type { RuntimeModelSelection } from '@peer-agent/runtime-node';

import type { ChatMessage, ChatSnapshot } from './chat-controller.ts';
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

function storedMessage(value: Record<string, unknown>, index: number): ChatMessage | null {
  if (!['user', 'assistant', 'tool'].includes(String(value.role)) || typeof value.content !== 'string') return null;
  return {
    id: typeof value.id === 'string' ? value.id : `restored-${index}`,
    role: value.role as ChatMessage['role'],
    content: value.content,
  };
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
        for (const message of newMessages) {
          store.appendMessage(id, { ...message, timestamp: now() });
          persistedMessageIds.add(message.id);
        }

        const completedAssistant = [...newMessages].reverse().find((message) => message.role === 'assistant');
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
