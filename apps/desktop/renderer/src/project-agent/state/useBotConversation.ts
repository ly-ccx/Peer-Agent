import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
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

export type BotConversationStatus = 'loading' | 'ready' | 'error';

function pageMessages(raw: readonly Record<string, unknown>[] | undefined): BotChatMessage[] {
  const normalized: BotChatMessage[] = [];
  for (const item of raw ?? []) {
    const message = normalizeBotMessage(item);
    if (message) normalized.push(message);
  }
  return normalized;
}

function lastRawId(raw: readonly Record<string, unknown>[] | undefined): string | null {
  const last = raw && raw.length > 0 ? raw[raw.length - 1] : null;
  const id = last && typeof last.id === 'string' ? last.id.trim() : '';
  return id || null;
}

export function useBotConversation(workspaceId: string) {
  const [messages, setMessages] = useState<readonly BotChatMessage[]>([]);
  const [pending, setPending] = useState<readonly PendingBotInput[]>([]);
  const [status, setStatus] = useState<BotConversationStatus>('loading');
  const [awaitingSince, setAwaitingSince] = useState<string | null>(null);
  const tailRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const generationRef = useRef(0);

  const dropEchoed = useCallback((next: readonly BotChatMessage[]) => {
    setPending((current) => current.filter((item) => !next.some((message) => (
      message.inputId === item.inputId || message.id === optimisticInputMessageId(item.inputId)
    ))));
  }, []);

  const load = useCallback(async (id: string, ticket: number) => {
    loadingRef.current = true;
    let before: string | null = null;
    let all: BotChatMessage[] = [];
    let tail: string | null = null;
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
        all = mergeConversationPage(all, pageMessages(raw));
        tail = lastRawId(raw) ?? tail;
        if (!result.nextCursor) break;
        before = result.nextCursor;
      }
      if (generationRef.current !== ticket) return;
      tailRef.current = tail;
      setMessages(all);
      dropEchoed(all);
      setStatus('ready');
    } catch {
      if (generationRef.current === ticket) setStatus('error');
    } finally {
      if (generationRef.current === ticket) loadingRef.current = false;
    }
  }, [dropEchoed]);

  const appendAfterTail = useCallback(async (id: string) => {
    const ticket = generationRef.current;
    if (loadingRef.current) return;
    let before = tailRef.current;
    if (!before) {
      await load(id, ticket);
      return;
    }
    let guard = 0;
    while (guard < 40) {
      guard += 1;
      if (generationRef.current !== ticket) return;
      const result = await clientApi.projectAgentReadConversation({
        workspaceId: id,
        limit: CONVERSATION_PAGE_SIZE,
        before,
      });
      if (generationRef.current !== ticket || !result?.ok) return;
      const raw = result.messages ?? [];
      const incoming = pageMessages(raw);
      if (incoming.length > 0) {
        setMessages((current) => {
          const merged = mergeConversationPage([...current], incoming);
          dropEchoed(merged);
          return merged;
        });
      }
      const nextTail = lastRawId(raw);
      if (nextTail) tailRef.current = nextTail;
      if (!result.nextCursor || raw.length === 0) break;
      before = result.nextCursor;
    }
    if (generationRef.current !== ticket) return;
    void clientApi.projectAgentMarkRead({ workspaceId: id }).catch(() => {});
  }, [dropEchoed, load]);

  useEffect(() => {
    const ticket = generationRef.current + 1;
    generationRef.current = ticket;
    setMessages([]);
    setPending([]);
    setAwaitingSince(null);
    setStatus('loading');
    tailRef.current = null;
    void load(workspaceId, ticket).then(() => {
      if (generationRef.current !== ticket) return;
      void clientApi.projectAgentMarkRead({ workspaceId }).catch(() => {});
    });
  }, [load, workspaceId]);

  useEffect(() => {
    const onChange = (event: { workspaceIds?: readonly string[] }) => {
      const ids = event?.workspaceIds ?? [];
      if (ids.length > 0 && !ids.includes(workspaceId)) return;
      void appendAfterTail(workspaceId);
    };
    const off = clientApi.onProjectAgentConversationChanged(onChange);
    return () => {
      off?.();
    };
  }, [appendAfterTail, workspaceId]);

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

  const shown = applyOptimistic(messages, pending);
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
