import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import type { ProjectAgentActivity, ProjectInputAttachment } from '@peer-agent/protocol';
import { answeredInputIds, attachBotProcesses, isActivityRunning, mergeBotActivity, visibleBotActivity } from './botActivityState';
import { continuousReplyRows, type AwaitingBotInput } from './botReplyContinuity';
import { questionForInput, hideAcknowledgedQuestions } from './botQuestionState';
import { createConversationRefresh } from './conversationRefresh.ts';
import { createConversationPager } from './conversationPager.ts';
import { mergeConversationCards, statusAfterRefreshFailure } from './conversationSections.ts';
import {
  acknowledgeInput,
  applyOptimistic,
  conversationRows,
  optimisticInputMessageId,
  type BotChatMessage,
  type ConversationDisplayRow,
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
  const [cards, setCards] = useState<readonly Record<string, unknown>[]>([]);
  const [cardsError, setCardsError] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [awaitingInputs, setAwaitingInputs] = useState<readonly AwaitingBotInput[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [activity, setActivity] = useState<ProjectAgentActivity | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState(false);
  const [followRequestId, setFollowRequestId] = useState(0);
  const pagerRef = useRef<ReturnType<typeof createConversationPager> | null>(null);
  const generationRef = useRef(0);
  const activityEventRef = useRef(0);
  const replyIdentitiesRef = useRef(new Map<string, string>());
  const refreshRef = useRef<(() => void) | null>(null);

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
    setAwaitingInputs([]);
    setHasOlder(false);
    setOlderError(false);
    setStatus('loading');
    setCards([]); setCardsError(false); setRefreshError(false);
    setActivity(null); setStopping(false); setStopError(false);
    replyIdentitiesRef.current = new Map();
    const pager = createConversationPager({
      read: async params => {
        const revision = activityEventRef.current;
        const result = await clientApi.projectAgentReadConversation({ workspaceId, ...params, presentationOnly: true, view: 'interactions' });
        // A fresh host snapshot can prove an old stream is gone. A late read cannot erase a newer push.
        if (!params.before && result?.ok && result.activity === null && generationRef.current === ticket
          && activityEventRef.current === revision) setActivity(null);
        return result;
      },
      publish: snapshot => {
        if (generationRef.current !== ticket) return;
        setMessages(snapshot.messages);
        setActivity(current => mergeBotActivity(current, snapshot.activity, workspaceId));
        dropEchoed(snapshot.messages);
        setHasOlder(snapshot.hasOlder);
        if ('familiarizeOffer' in snapshot) setFamiliarizeOffer(readFamiliarizeOffer(snapshot.familiarizeOffer));
        setStatus('ready');
        setRefreshError(false);
      },
    });
    pagerRef.current = pager;
    const cardRefresh = createConversationRefresh(async () => {
      try {
        const result = await clientApi.projectAgentReadConversation({ workspaceId, view: 'cards' });
        if (generationRef.current !== ticket) return;
        if (!result.ok) { setCardsError(true); return; }
        setCards(result.cards ?? []); setCardsError(false);
      } catch { if (generationRef.current === ticket) setCardsError(true); }
    }, { delayMs: 80 });
    const refresh = createConversationRefresh(async () => {
      try { await pager.refresh(); }
      catch { if (generationRef.current === ticket) { setStatus(statusAfterRefreshFailure); setRefreshError(true); } }
      if (generationRef.current === ticket) {
        void cardRefresh.request();
        void clientApi.projectAgentMarkRead({ workspaceId }).catch(() => {});
      }
    }, { delayMs: 80 });
    const onChange = (event: { workspaceIds?: readonly string[] }) => {
      const ids = event?.workspaceIds ?? [];
      if (ids.length > 0 && !ids.includes(workspaceId)) return;
      void refresh.request();
    };
    refreshRef.current = () => { void refresh.request(); };
    const offMessages = clientApi.onProjectAgentConversationChanged(onChange);
    const offFacts = clientApi.onProjectAgentChanged(onChange);
    const offActivity = clientApi.onProjectAgentActivity(event => {
      if (generationRef.current !== ticket || event.workspaceId !== workspaceId) return;
      activityEventRef.current += 1;
      setActivity(current => mergeBotActivity(current, event, workspaceId));
      if (['awaiting_permission', 'done', 'error', 'stopped', 'disposed'].includes(event.phase)) void refresh.request();
    });
    void refresh.request();
    return () => {
      refresh.stop();
      cardRefresh.stop();
      pager.stop();
      if (pagerRef.current === pager) pagerRef.current = null;
      refreshRef.current = null;
      generationRef.current += 1;
      offMessages?.();
      offFacts?.();
      offActivity?.();
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
    const answered = answeredInputIds(messages);
    setAwaitingInputs(current => current.some(input => answered.has(`input-${input.inputId}`))
      ? current.filter(input => !answered.has(`input-${input.inputId}`)) : current);
  }, [messages]);

  const submit = useCallback(async (inputId: string, text: string, quoteRefs: readonly string[], createdAt: string, answerTo?: string, attachments: readonly ProjectInputAttachment[] = []) => {
    const ticket = generationRef.current;
    setAwaitingInputs(current => [...current.filter(input => input.inputId !== inputId), { inputId, createdAt }]);
    setPending((current) => {
      const rest = current.filter((item) => item.inputId !== inputId);
      return [...rest, { inputId, text, quoteRefs, attachments, createdAt, state: 'sending', ...(answerTo ? { answerTo } : {}) }];
    });
    try {
      const result = await clientApi.projectAgentSubmitInput({
        workspaceId,
        inputId,
        text,
        surface: 'desktop',
        ...(attachments.length ? { attachments } : {}),
        ...(quoteRefs.length > 0 ? { quoteRefs } : {}),
        ...(answerTo ? { answerTo } : {}),
      });
      if (generationRef.current !== ticket) return { ok: false, code: 'STALE_INPUT' };
      if (!result?.ok) {
        if (result?.input?.inputId === inputId) {
          setPending(current => acknowledgeInput(current, inputId));
          setAwaitingInputs(current => current.map(input => input.inputId === inputId ? { ...input, deliveryIssue: true } : input));
          return result;
        }
        setAwaitingInputs(current => current.filter(input => input.inputId !== inputId));
        setPending((current) => current.map((item) => (
          item.inputId === inputId ? { ...item, state: 'failed' } : item
        )));
        return result;
      }
      setPending(current => acknowledgeInput(current, inputId));
      return result;
    } catch {
      if (generationRef.current !== ticket) return { ok: false, code: 'STALE_INPUT' };
      setAwaitingInputs(current => current.filter(input => input.inputId !== inputId));
      setPending((current) => current.map((item) => (
        item.inputId === inputId ? { ...item, state: 'failed' } : item
      )));
      return { ok: false, code: 'SEND_FAILED' };
    }
  }, [workspaceId]);

  const decorated = useMemo(() => mergeConversationCards(messages, cardsError ? [] : cards), [messages, cards, cardsError]);
  const send = useCallback(async (text: string, quoteRefs: readonly string[] = [], attachments: readonly ProjectInputAttachment[] = []) => {
    const trimmed = text.trim();
    if (!trimmed && !attachments.length) return;
    const inputId = crypto.randomUUID();
    setFollowRequestId(value => value + 1);
    const answerTo = questionForInput(applyOptimistic(decorated, pending), quoteRefs);
    await submit(inputId, trimmed, quoteRefs, new Date().toISOString(), answerTo, attachments);
  }, [submit, decorated, pending]);

  const answer = useCallback(async (text: string, answerTo?: string) => {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, code: 'INVALID_INPUT' };
    setFollowRequestId(value => value + 1);
    return submit(crypto.randomUUID(), trimmed, [], new Date().toISOString(), answerTo);
  }, [submit]);

  const retry = useCallback(async (inputId: string) => {
    const item = pending.find((entry) => entry.inputId === inputId);
    if (!item) return;
    await submit(item.inputId, item.text, item.quoteRefs, item.createdAt, item.answerTo, item.attachments);
  }, [pending, submit]);

  useEffect(() => { if (!isActivityRunning(activity)) setStopping(false); }, [activity]);

  const offered = useMemo(() => familiarizeOffer && !decorated.some(message => ['user_input', 'agent_reply'].includes(message.kind))
    ? [...decorated, familiarizeMessage(familiarizeOffer, decorated[decorated.length - 1]?.createdAt || '')]
    : decorated, [familiarizeOffer, decorated]);
  const shown = useMemo(() => hideAcknowledgedQuestions(applyOptimistic(offered, pending)), [offered, pending]);
  const historyRows = useMemo(() => conversationRows(shown), [shown]);
  const rows: ConversationDisplayRow[] = useMemo(() => {
    const next: ConversationDisplayRow[] = attachBotProcesses(historyRows, shown, activity);
    const current = visibleBotActivity(activity, shown);
    if (current) next.push({ type: 'activity', activity: current });
    return next;
  }, [historyRows, shown, activity]);
  const viewRows = useMemo(() => continuousReplyRows(rows, shown, awaitingInputs, pending, replyIdentitiesRef.current,
    stopping ? activity?.turnId : undefined), [rows, shown, awaitingInputs, pending, stopping, activity?.turnId]);
  const stop = async () => {
    if (!isActivityRunning(activity) || !activity || stopping) return;
    const ticket = generationRef.current;
    setStopping(true); setStopError(false);
    let accepted = false;
    try {
      const result = await clientApi.projectAgentStopResponse({ workspaceId, turnId: activity.turnId });
      accepted = result.ok;
      if (generationRef.current === ticket && !result.ok && result.code !== 'STALE_TURN') setStopError(true);
    } catch { if (generationRef.current === ticket) setStopError(true); }
    finally { if (generationRef.current === ticket && !accepted) setStopping(false); }
  };

  return {
    status,
    reload: () => refreshRef.current?.(),
    cardsError, refreshError,
    messages: shown,
    rows,
    viewRows,
    generating: isActivityRunning(activity),
    activeModelSelection: isActivityRunning(activity) ? activity?.modelSelection : undefined,
    stopping, stopError, stop, followRequestId,
    hasOlder,
    olderError,
    loadOlder,
    locateMessage,
    send,
    answer,
    retry,
  };
}
