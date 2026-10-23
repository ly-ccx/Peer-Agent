import { approvalCardReceipt, cardDecisionKey } from '../state/cardDecisionReceipt';
import { inputRecoveryFor } from '../state/useInputRecovery';
import type { I18nRuntime } from '@peer-agent/i18n';
import { useContext, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { PeerIcon } from '../../ui/icons';
import type { BotChatCard, BotChatCardAction } from '../state/botConversationState';
import { readBotCards, agentFailurePresentation } from '../state/botConversationState';
import { budgetFailureDetail } from '../state/replyRecoveryState';
import { cardActionErrorKey } from '../state/cardActionError';
import { CompletionReview } from './CompletionReview';
import { BotInputContext } from './BotInputContext';
import { useQuestionDismissal } from './useQuestionDismissal';
import { useCardPresence } from './useCardPresence';
import { ApprovalReceipt } from './ApprovalReceipt';

/**
 * 所有动作通过应用服务，由宿主校验状态与项目归属。
 */
export function CardView({
  workspaceId,
  cards,
  i18n,
  onDone,
}: {
  readonly workspaceId: string;
  readonly cards: readonly BotChatCard[];
  readonly i18n: I18nRuntime;
  readonly onDone?: () => void;
}) {
  const presence = useCardPresence(cards);
  if (presence.visible.length === 0) return null;
  return (
    <div className="bot-cards">
      {presence.visible.map((card) => (
        <CardItem key={card.cardId} workspaceId={workspaceId} card={card} i18n={i18n} onDone={onDone} onClosed={() => presence.close(card.cardId)} />
      ))}
    </div>
  );
}

/** Provider diagnostics are preserved for inspection, separate from actionable cards. */
export function CardDiagnostics({ cards, i18n }: { readonly cards: readonly BotChatCard[]; readonly i18n: I18nRuntime }) {
  return <>{cards.filter(card => card.kind === 'agent_unavailable' && card.content).map(card => (
    <section className="bot-context-error" key={card.cardId}>
      <h3>{i18n.t('projectAgent.chat.context.error')}</h3>
      <pre>{card.content}</pre>
    </section>
  ))}</>;
}

function CardItem({
  workspaceId,
  card: sourceCard,
  i18n,
  onDone,
  onClosed,
}: {
  readonly workspaceId: string;
  readonly card: BotChatCard;
  readonly i18n: I18nRuntime;
  readonly onDone?: () => void;
  readonly onClosed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<{ key: string; source: BotChatCard; card: BotChatCard } | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [retired, setRetired] = useState<{ key: string; source: BotChatCard } | null>(null);
  const key = `${workspaceId}:${cardDecisionKey(sourceCard)}`;
  const card = sourceCard.resolvedState === 'resolved' ? sourceCard : receipt?.key === key && receipt.source === sourceCard ? receipt.card : sourceCard;
  const waitingForFacts = submitted === key && card.resolvedState !== 'resolved';
  const sending = useRef(false);
  const submitInput = useContext(BotInputContext);
  const resolved = card.resolvedState === 'resolved';
  const failure = card.kind === 'agent_unavailable' ? agentFailurePresentation(card) : undefined;
  const budgetDetail = failure && !failure.recovering ? budgetFailureDetail(card.recoveryAction) : null;
  const actions = card.actions?.filter(action => action.id !== 'retry' || failure?.retryAllowed !== false);
  const imageApproval = card.kind === 'approval' && (card.refs?.capabilityId === 'local.image.read' || actions?.some(a => a.payload?.capabilityId === 'local.image.read'));
  const imageState = card.resolution?.state;
  const imageNotice = card.refs?.decisionReason === 'permission_policy_changed' ? 'projectAgent.access.changed' : card.refs?.decisionReason === 'permission_timeout' ? 'projectAgent.chat.imageTimeout'
    : card.refs?.decisionReason === 'permission_unavailable' ? 'projectAgent.chat.imageUnavailable'
    : imageState === 'cancelled' ? 'projectAgent.chat.imageCancelled'
    : imageState === 'denied' ? 'projectAgent.chat.imageDenied'
    : imageState === 'approved' ? 'projectAgent.chat.imageApproved' : imageState === 'expired' ? 'projectAgent.chat.imageUnavailable' : 'projectAgent.chat.imageReadNotice';
  async function refreshFacts() {
    try {
      const latest = await clientApi.projectAgentReadConversation({ workspaceId, view: 'cards' });
      if (!latest.ok || !Array.isArray(latest.cards)) throw new Error('unavailable');
      const current = readBotCards(latest.cards).find(item => item.cardId === sourceCard.cardId);
      if (current) setReceipt({ key, source: sourceCard, card: current });
      else setRetired({ key, source: sourceCard });
      onDone?.();
    } catch { setError(i18n.t('projectAgent.chat.cardsUnavailable')); }
  }
  const question = card.kind === 'question';
  const dismissal = useQuestionDismissal(question && resolved, onClosed, node =>
    node.closest('.bot-convo')?.querySelector<HTMLTextAreaElement>('.bot-composer textarea:not(:disabled)') ?? null);
  if (retired?.key === key && retired.source === sourceCard || question && !dismissal.present) return null;
  if (['approval', 'plan_approval'].includes(card.kind) && resolved) return <ApprovalReceipt card={card} i18n={i18n} notice={imageApproval ? imageNotice : undefined} />;
  return (
    <section ref={dismissal.ref} aria-busy={busy} inert={question && resolved ? true : undefined} aria-hidden={question && resolved ? true : undefined}
      className={`bot-card${card.kind === 'agent_stopped' ? ' bot-stopped-reply' : ''}${card.kind === 'agent_unavailable' ? ' bot-unavailable-reply' : ''}${question ? ' bot-question' : ''}${resolved ? ' is-resolved' : ''}`} data-card-id={card.cardId}>
      {card.completionReview ? <CompletionReview title={card.content} review={card.completionReview} i18n={i18n} /> : card.kind === 'agent_stopped' ? <>
        {card.content ? <div className="bot-reply-body"><MarkdownMessage content={card.content} /></div> : null}
        <p className="bot-live-status"><PeerIcon name="stop" size={13} />{i18n.t('projectAgent.chat.stopped')}</p>
      </> : failure ? <><p className="bot-reply-body" role={failure.recovering ? 'status' : undefined}>{i18n.t(failure.messageKey)}</p>
        {budgetDetail ? <p className="bot-live-status">{i18n.t(budgetDetail.key, budgetDetail.params)} {i18n.t(budgetDetail.sourceKey)}</p> : null}
        {card.failureStatus?.activeSessionIds.length ? <p className="bot-live-status">{i18n.t('projectAgent.chat.childWorkContinues', { count: card.failureStatus.activeSessionIds.length })}</p> : null}</>
        : card.kind === 'approval' && card.refs?.decisionReason === 'permission_policy_changed' ? <><p role="status">{i18n.t('projectAgent.access.changed')}</p><p>{card.content}</p></>
        : imageApproval ? <><p role="status">{i18n.t(imageNotice)}</p><p>{card.content}</p>{!resolved && card.refs?.deadlineAt ? <p className="bot-drawer-note">{i18n.t('projectAgent.chat.imageWaitLimit')}</p> : null}</>
        : <p>{card.kind === 'question' && card.cardId.startsWith('card:question:reply:') ? i18n.t('projectAgent.chat.chooseAnswer') : card.content}</p>}
      {resolved && !question || !actions?.length ? null : (
        <div className="bot-card-actions">
          {actions.map((action, index) => (
            <button
              key={`${action.id}-${index}`}
              type="button"
              disabled={busy || waitingForFacts || resolved}
              onClick={() => {
                if (sending.current || waitingForFacts || resolved) return;
                sending.current = true;
                setBusy(true); setError('');
                const text = typeof action.payload?.text === 'string' ? action.payload.text : '';
                const answerTo = typeof action.payload?.answerTo === 'string' ? action.payload.answerTo : undefined;
                const request = submitInput && action.channel === 'project-agent:submit-input'
                  ? submitInput(text, answerTo) : runCardAction(workspaceId, action);
                void request.then(result => {
                  const factualReceipt = approvalCardReceipt(workspaceId, sourceCard, result);
                  if (factualReceipt) setReceipt({ key, source: sourceCard, card: factualReceipt });
                  if (!result?.ok) { setError(i18n.t(cardActionErrorKey(result?.code))); void refreshFacts(); return; }
                  if (submitInput && action.channel === 'project-agent:submit-input') {
                    dismissal.ref.current?.closest('.bot-convo')?.querySelector<HTMLTextAreaElement>('.bot-composer textarea')?.focus({ preventScroll: true });
                  }
                  if (!factualReceipt) { setSubmitted(key); void refreshFacts(); }
                  else onDone?.();
                }).catch(() => setError(i18n.t('projectAgent.chat.actionFailed'))).finally(() => { sending.current = false; setBusy(false); });
              }}
            >
              {actionLabel(action, i18n)}
            </button>
          ))}
        </div>
      )}
      {waitingForFacts ? <p role="status">{i18n.t('projectAgent.chat.decisionUpdating')} <button type="button" onClick={() => void refreshFacts()}>{i18n.t('projectAgent.history.retry')}</button></p> : null}
      {!resolved && error ? <p role="alert" className="bot-drawer-note">{error}</p> : null}
    </section>
  );
}

function actionLabel(action: BotChatCardAction, i18n: I18nRuntime): string {
  const text = typeof action.payload?.text === 'string' ? action.payload.text.trim() : '';
  if (text) return text;
  if (action.id === 'allow') return i18n.t('projectAgent.chat.allowOnce');
  if (action.id === 'allow_task') return i18n.t(action.payload?.capabilityId === 'local.image.read' ? 'projectAgent.chat.allowImage' : 'projectAgent.chat.allowTask');
  if (action.id === 'continue') return i18n.t('projectAgent.chat.approveContinue');
  if (action.id === 'approve') return i18n.t('projectAgent.chat.approve');
  if (action.id === 'cancel_read') return i18n.t('projectAgent.chat.cancelImageRead');
  if (action.id === 'reject') return i18n.t('projectAgent.chat.reject');
  if (action.id === 'answer') return i18n.t('projectAgent.chat.answer');
  if (action.id === 'confirm') return i18n.t('projectAgent.chat.confirmResult');
  if (action.id === 'confirm_completion') return i18n.t('projectAgent.chat.confirmCompletion');
  if (action.id === 'retry_completion') return i18n.t('projectAgent.chat.retryCompletion');
  if (action.id === 'accept_readme') return i18n.t('projectAgent.chat.acceptReadme');
  if (action.id === 'retry') return i18n.t('projectAgent.chat.continueRetry');
  return action.id;
}

async function runCardAction(workspaceId: string, action: BotChatCardAction): Promise<{ ok: boolean; code?: string }> {
  const payload = action.payload || {};
  if (action.channel === 'project-memory:restore' && typeof payload.id === 'string' && payload.resolveConflict === true) {
    return clientApi.projectMemoryRestore({ workspaceId, id: payload.id, resolveConflict: true });
  }
  if (action.channel === 'project-agent:decide-approval') {
    const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : '';
    const decision = payload.decision;
    const duration = payload.duration;
    if (!approvalId || (decision !== 'approve' && decision !== 'reject' && decision !== 'deny' && decision !== 'cancel')) return { ok: false, code: 'INVALID_INPUT' };
    return clientApi.projectAgentDecideApproval({ workspaceId, approvalId, decision,
      ...(duration === 'once' || duration === 'task' || duration === 'denied' ? { duration } : {}) });
  }
  if (action.channel === 'project-agent:submit-input') {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const answerTo = typeof payload.answerTo === 'string' ? payload.answerTo : '';
    if (!text) return { ok: false, code: 'INVALID_INPUT' };
    return inputRecoveryFor(workspaceId).send({ text, answerTo, useDraft: false });
  }
  if (action.channel === 'project-agent:start-familiarize') return clientApi.projectAgentStartFamiliarize({ workspaceId });
  if (action.channel === 'project-agent:confirm-result' && typeof payload.sessionId === 'string') {
    if (payload.stage === 'manual_completion' && (typeof payload.reviewToken !== 'string' || !payload.reviewToken)) return { ok: false, code: 'INVALID_INPUT' };
    const confirmation = payload.stage === 'manual_completion' && typeof payload.reviewToken === 'string'
      ? { workspaceId, sessionId: payload.sessionId, stage: 'manual_completion', reviewToken: payload.reviewToken } as const
      : { workspaceId, sessionId: payload.sessionId };
    return clientApi.projectAgentConfirmResult(confirmation);
  }
  if (action.channel === 'project-agent:accept-readme') return clientApi.projectAgentAcceptReadme({ workspaceId });
  if (action.channel === 'project-agent:retry' && typeof payload.turnId === 'string') return clientApi.projectAgentRetry({ workspaceId, turnId: payload.turnId });
  return { ok: false, code: 'INVALID_ACTION' };
}
