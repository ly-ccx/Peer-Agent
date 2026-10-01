import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { createConversationRefresh } from './conversationRefresh.ts';
import { createConversationPager } from './conversationPager.ts';
import {
  acknowledgeInput,
  applyOptimistic,
  conversationRows,
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

export function useBotConversation(workspaceId: string) {
  const [messages, setMessages] = useState<readonly BotChatMessage[]>([]);
  const [familiarizeOffer, setFamiliarizeOffer] = useState<FamiliarizeOffer | null>(null);
  const [pending, setPending] = useState<readonly PendingBotInput[]>([]);
  const [status, setStatus] = useState<BotConversationStatus>('loading');
  const [awaitingSince, setAwaitingSince] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const pagerRef = useRef<ReturnType<typeof createConversationPager> | null>(null);
  const generationRef = useRef(0);

  const dropEchoed = useCallback((next: readonly BotChatMessage[]) => {
    setPending((current) => current.filter((item) => !next.some((message) => (
      message.inputId === item.inputId || message.id === optimisticInputMessageId(item.inputId)
    ))));
  }, []);

  useEffect(() => {
    const ticket = generationRef.current + 1;
    generationRef.current = ticket;
    setMessages([]);
    setFamiliarizeOffer(null);
    setPending([]);
    setAwaitingSince(null);
    setHasOlder(false);
    setOlderError(false);
    setStatus('loading');
    const pager = createConversationPager({
      read: params => clientApi.projectAgentReadConversation({ workspaceId, ...params }),
      publish: snapshot => {
        if (generationRef.current !== ticket) return;
        setMessages(snapshot.messages);
        dropEchoed(snapshot.messages);
        setHasOlder(snapshot.hasOlder);
        if ('familiarizeOffer' in snapshot) setFamiliarizeOffer(readFamiliarizeOffer(snapshot.familiarizeOffer));
        setStatus('ready');
      },
    });
    pagerRef.current = pager;
    const refresh = createConversationRefresh(async () => {
      try { await pager.refresh(); }
      catch { if (generationRef.current === ticket) setStatus('error'); }
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
      pager.stop();
      if (pagerRef.current === pager) pagerRef.current = null;
      generationRef.current += 1;
      offMessages?.();
      offFacts?.();
    };
  }, [dropEchoed, workspaceId]);

  const loadOlder = useCallback(async () => {
    const pager = pagerRef.current;
    setOlderError(false);
    try { await pager?.older(); }
    catch { if (pagerRef.current === pager) setOlderError(true); }
  }, []);
  const locateMessage = useCallback(async (id: string) => {
    const pager = pagerRef.current;
    try { await pager?.locate(id); }
    catch { if (pagerRef.current === pager) setOlderError(true); }
  }, []);

  useEffect(() => {
    if (!awaitingSince) return;
    const arrived = messages.some((message) => (
      message.kind !== 'user_input' && message.createdAt >= awaitingSince && !message.pending
    ));
    if (arrived) setAwaitingSince(null);
  }, [awaitingSince, messages]);

  const submit = useCallback(async (inputId: string, text: string, quoteRefs: readonly string[], createdAt: string) => {
    const ticket = generationRef.current;
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
      if (generationRef.current !== ticket) return;
      if (!result?.ok) {
        setPending((current) => current.map((item) => (
          item.inputId === inputId ? { ...item, state: 'failed' } : item
        )));
        return;
      }
      setPending(current => acknowledgeInput(current, inputId));
      setAwaitingSince(createdAt);
    } catch {
      if (generationRef.current !== ticket) return;
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
    hasOlder,
    olderError,
    loadOlder,
    locateMessage,
    send,
    retry,
  };
}
