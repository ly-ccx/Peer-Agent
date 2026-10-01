import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { createConversationRefresh } from './conversationRefresh.ts';
import {
  applyOptimistic,
  CONVERSATION_PAGE_SIZE,
  conversationRows,
  mergeConversationPage,
  normalizeBotMessage,
  optimisticInputMessageId,
  showAgentThinking,
  type BotChatMessage,
  type ConversationRow,
  type PendingBotInput,
} from './botConversationState';

interface FamiliarizeOffer {
  readonly text: string;
  readonly action: string;
}

export type BotConversationStatus = 'loading' | 'ready' | 'error';

function readFamiliarizeOffer(value: unknown): FamiliarizeOffer | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { text?: unknown; action?: unknown };
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!text) return null;
  const action = typeof record.action === 'string' && record.action.trim() ? record.action.trim() : '先熟悉一下';
  return { text, action };
}

function familiarizeMessage(offer: FamiliarizeOffer, createdAt: string): BotChatMessage {
  return {
    id: 'familiarize-offer',
    kind: 'system_card',
    role: 'assistant',
    content: offer.text,
    createdAt,
    replyTo: [],
    sources: [],
    marks: [],
    dispositions: [],
    rounds: [],
    meta: {},
    proactive: false,
    cards: [{
      cardId: 'familiarize-offer',
      kind: 'familiarize',
      content: offer.text,
      actions: [{
        id: 'familiarize',
        channel: 'project-agent:start-familiarize',
        payload: { text: offer.action },
      }],
    }],
    quoteRefs: [],
    separatorLabel: '',
  };
}

function pageMessages(raw: readonly Record<string, unknown>[] | undefined): BotChatMessage[] {
  const normalized: BotChatMessage[] = [];
  for (const item of raw ?? []) {
    const message = normalizeBotMessage(item);
    if (message) normalized.push(message);
  }
  return normalized;
}

export function useBotConversation(workspaceId: string) {
  const [messages, setMessages] = useState<readonly BotChatMessage[]>([]);
  const [familiarizeOffer, setFamiliarizeOffer] = useState<FamiliarizeOffer | null>(null);
  const [pending, setPending] = useState<readonly PendingBotInput[]>([]);
  const [status, setStatus] = useState<BotConversationStatus>('loading');
  const [awaitingSince, setAwaitingSince] = useState<string | null>(null);
  const generationRef = useRef(0);

  const dropEchoed = useCallback((next: readonly BotChatMessage[]) => {
    setPending((current) => current.filter((item) => !next.some((message) => (
      message.inputId === item.inputId || message.id === optimisticInputMessageId(item.inputId)
    ))));
  }, []);

  const load = useCallback(async (id: string, ticket: number) => {
    let before: string | null = null;
    let all: BotChatMessage[] = [];
    try {
      for (let page = 0; page < 40; page += 1) {
        const result = await clientApi.projectAgentReadConversation({
          workspaceId: id,
          limit: CONVERSATION_PAGE_SIZE,
          ...(before ? { before } : {}),
        });
        if (generationRef.current !== ticket) return;
        if (!result?.ok) {
          setStatus('error');
          return;
        }
        const raw = result.messages ?? [];
        if (page === 0) setFamiliarizeOffer(readFamiliarizeOffer(result.familiarizeOffer));
        all = mergeConversationPage(all, pageMessages(raw));
        if (!result.nextCursor) break;
        before = result.nextCursor;
      }
      if (generationRef.current !== ticket) return;
      setMessages(all);
      dropEchoed(all);
      setStatus('ready');
    } catch {
      if (generationRef.current === ticket) setStatus('error');
    }
  }, [dropEchoed]);

  useEffect(() => {
    const ticket = generationRef.current + 1;
    generationRef.current = ticket;
    setMessages([]);
    setFamiliarizeOffer(null);
    setPending([]);
    setAwaitingSince(null);
    setStatus('loading');
    const refresh = createConversationRefresh(async () => {
      await load(workspaceId, ticket);
      if (generationRef.current === ticket) {
        void clientApi.projectAgentMarkRead({ workspaceId }).catch(() => {});
      }
    });
    const onChange = (event: { workspaceIds?: readonly string[] }) => {
      const ids = event?.workspaceIds ?? [];
      if (ids.length > 0 && !ids.includes(workspaceId)) return;
      void refresh.request();
    };
    const offMessages = clientApi.onProjectAgentConversationChanged(onChange);
    const offFacts = clientApi.onProjectAgentChanged(onChange);
    void refresh.request();
    return () => {
      refresh.stop();
      generationRef.current += 1;
      offMessages?.();
      offFacts?.();
    };
  }, [load, workspaceId]);

  useEffect(() => {
    if (!awaitingSince) return;
    const arrived = messages.some((message) => (
      message.kind !== 'user_input' && message.createdAt >= awaitingSince && !message.pending
    ));
    if (arrived) setAwaitingSince(null);
  }, [awaitingSince, messages]);

  const submit = useCallback(async (inputId: string, text: string, quoteRefs: readonly string[], createdAt: string) => {
    setPending((current) => {
      const rest = current.filter((item) => item.inputId !== inputId);
      return [...rest, { inputId, text, quoteRefs, createdAt, state: 'sending' }];
    });
    try {
      const result = await clientApi.projectAgentSubmitInput({
        workspaceId,
        inputId,
        text,
        surface: 'desktop',
        ...(quoteRefs.length > 0 ? { quoteRefs } : {}),
      });
      if (!result?.ok) {
        setPending((current) => current.map((item) => (
          item.inputId === inputId ? { ...item, state: 'failed' } : item
        )));
        return;
      }
      setAwaitingSince(createdAt);
    } catch {
      setPending((current) => current.map((item) => (
        item.inputId === inputId ? { ...item, state: 'failed' } : item
      )));
    }
  }, [workspaceId]);

  const send = useCallback(async (text: string, quoteRefs: readonly string[] = []) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const inputId = crypto.randomUUID();
    await submit(inputId, trimmed, quoteRefs, new Date().toISOString());
  }, [submit]);

  const retry = useCallback(async (inputId: string) => {
    const item = pending.find((entry) => entry.inputId === inputId);
    if (!item) return;
    await submit(item.inputId, item.text, item.quoteRefs, item.createdAt);
  }, [pending, submit]);

  const offered = familiarizeOffer
    ? [...messages, familiarizeMessage(familiarizeOffer, messages[messages.length - 1]?.createdAt || '')]
    : messages;
  const shown = applyOptimistic(offered, pending);
  const rows: ConversationRow[] = conversationRows(shown);

  return {
    status,
    messages: shown,
    rows,
    thinking: showAgentThinking(pending, awaitingSince !== null),
    send,
    retry,
  };
}
