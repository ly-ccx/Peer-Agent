import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { useInputRecovery } from './useInputRecovery';
import { projectInputWasReceived, type ProjectAgentSubmitInputResult } from '@peer-agent/protocol';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { answeredInputIds, attachBotProcesses, isActivityRunning, mergeBotActivity, visibleBotActivity } from './botActivityState';
import { continuousReplyRows, type AwaitingBotInput } from './botReplyContinuity';
import { questionForInput, hideAcknowledgedQuestions } from './botQuestionState';
import { createConversationRefresh } from './conversationRefresh.ts';
import { createConversationPager } from './conversationPager.ts';
import { mergeConversationCards, statusAfterRefreshFailure } from './conversationSections.ts';
import {
  applyOptimistic,
  conversationRows,
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
  const recovery = useInputRecovery(workspaceId);
  const pending = useMemo<readonly PendingBotInput[]>(() => [...recovery.state.pending.map(item => ({ ...item, state: recovery.state.sending.includes(item.inputId) ? 'sending' as const : 'unknown' as const })), ...recovery.state.received.map(item => ({ ...item, state: 'received' as const }))], [recovery.state.pending, recovery.state.received, recovery.state.sending]);
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
  const followRequestId = 0;
  const pagerRef = useRef<ReturnType<typeof createConversationPager> | null>(null);
  const generationRef = useRef(0);
  const activityEventRef = useRef(0);
  const replyIdentitiesRef = useRef(new Map<string, string>());
  const refreshRef = useRef<(() => void) | null>(null);

  const dropEchoed = useCallback((next: readonly BotChatMessage[]) => {
    recovery.session.observeReceived(next.filter(message => message.kind === 'user_input').flatMap(message =>
      message.inputId ? [message.inputId] : message.id.startsWith('input-') ? [message.id.slice(6)] : []));
  }, [recovery.session]);

  useEffect(() => { if (recovery.state.ready) dropEchoed(messages); }, [dropEchoed, messages, recovery.state.ready]);

  useEffect(() => {
    const ticket = generationRef.current + 1;
    generationRef.current = ticket;
    setMessages([]);
    setFamiliarizeOffer(null);
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
  const locateMessage = useCallback(async (id: string, maxPages?: number, isActive?: () => boolean) => {
    const pager = pagerRef.current;
    try { return await pager?.locate(id, maxPages, isActive) ?? false; }
    catch { if (pagerRef.current === pager) setOlderError(true); return false; }
  }, []);

  useEffect(() => {
    const answered = answeredInputIds(messages);
    setAwaitingInputs(current => current.some(input => answered.has(`input-${input.inputId}`))
      ? current.filter(input => !answered.has(`input-${input.inputId}`)) : current);
  }, [messages]);

  const decorated = useMemo(() => mergeConversationCards(messages, cardsError ? [] : cards), [messages, cards, cardsError]);
  const received = useCallback((result: ProjectAgentSubmitInputResult, ticket: number) => {
    const input = result.input;
    if (generationRef.current === ticket && input && projectInputWasReceived(result, workspaceId, input.inputId)) {
      setAwaitingInputs(current => [...current.filter(item => item.inputId !== input.inputId), {
        inputId: input.inputId, createdAt: input.createdAt, ...(!result.ok ? { deliveryIssue: true } : {}),
      }]);
    }
    return result;
  }, [workspaceId]);
  const send = useCallback(async (_text?: string, quoteRefs: readonly string[] = []) => {
    const ticket = generationRef.current;
    const answerTo = questionForInput(applyOptimistic(decorated, pending), quoteRefs);
    return received(await recovery.session.send({ quoteRefs, answerTo }), ticket);
  }, [recovery.session, decorated, pending, received]);
  const answer = useCallback(async (text: string, answerTo?: string) => {
    const ticket = generationRef.current;
    return received(await recovery.session.send({ text, answerTo, useDraft: false }), ticket);
  }, [recovery.session, received]);
  const retry = useCallback(async (inputId: string) => {
    const ticket = generationRef.current;
    return received(await recovery.session.retry(inputId), ticket);
  }, [recovery.session, received]);

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
    recovery,
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
