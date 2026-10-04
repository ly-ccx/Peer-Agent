import type { I18nRuntime } from '@peer-agent/i18n';
import { useState } from 'react';
import { clientApi } from '../../clientApi';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { PeerIcon } from '../../ui/icons';
import type { BotChatCard, BotChatCardAction } from '../state/botConversationState';

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
  if (cards.length === 0) return null;
  return (
    <div className="bot-cards">
      {cards.map((card) => (
        <CardItem key={card.cardId} workspaceId={workspaceId} card={card} i18n={i18n} onDone={onDone} />
      ))}
    </div>
  );
}

function CardItem({
  workspaceId,
  card,
  i18n,
  onDone,
}: {
  readonly workspaceId: string;
  readonly card: BotChatCard;
  readonly i18n: I18nRuntime;
  readonly onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const resolved = done || card.resolvedState === 'resolved';
  if (card.kind === 'question' && resolved) return null;
  return (
    <section className={`bot-card${card.kind === 'agent_stopped' ? ' bot-stopped-reply' : ''}${card.kind === 'question' ? ' bot-question' : ''}${resolved ? ' is-resolved' : ''}`} data-card-id={card.cardId}>
      {card.kind === 'agent_stopped' ? <>
        {card.content ? <div className="bot-reply-body"><MarkdownMessage content={card.content} /></div> : null}
        <p className="bot-live-status"><PeerIcon name="stop" size={13} />{i18n.t('projectAgent.chat.stopped')}</p>
      </> : <p>{card.kind === 'question' && card.cardId.startsWith('card:question:reply:') ? i18n.t('projectAgent.chat.chooseAnswer') : card.content}</p>}
      {resolved || !card.actions?.length ? null : (
        <div className="bot-card-actions">
          {card.actions.map((action, index) => (
            <button
              key={`${action.id}-${index}`}
              type="button"
              disabled={busy}
              onClick={() => {
                if (busy) return;
                setBusy(true); setError('');
                void runCardAction(workspaceId, action).then(result => {
                  if (!result?.ok) { setError(result?.code || i18n.t('projectAgent.chat.actionFailed')); return; }
                  setDone(true); onDone?.();
                }).catch(() => setError(i18n.t('projectAgent.chat.actionFailed'))).finally(() => setBusy(false));
              }}
            >
              {actionLabel(action, i18n)}
            </button>
          ))}
        </div>
      )}
      {error ? <p role="alert" className="bot-drawer-note">{error}</p> : null}
    </section>
  );
}

function actionLabel(action: BotChatCardAction, i18n: I18nRuntime): string {
  const text = typeof action.payload?.text === 'string' ? action.payload.text.trim() : '';
  if (text) return text;
  if (action.id === 'allow') return i18n.t('projectAgent.chat.allowOnce');
  if (action.id === 'allow_task') return i18n.t('projectAgent.chat.allowTask');
  if (action.id === 'continue') return i18n.t('projectAgent.chat.approveContinue');
  if (action.id === 'approve') return i18n.t('projectAgent.chat.approve');
  if (action.id === 'reject') return i18n.t('projectAgent.chat.reject');
  if (action.id === 'answer') return i18n.t('projectAgent.chat.answer');
  if (action.id === 'confirm') return i18n.t('projectAgent.chat.confirmResult');
  if (action.id === 'accept_readme') return i18n.t('projectAgent.chat.acceptReadme');
  if (action.id === 'retry') return i18n.t('projectAgent.chat.retry');
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
    if (!approvalId || (decision !== 'approve' && decision !== 'reject' && decision !== 'deny')) return { ok: false, code: 'INVALID_INPUT' };
    return clientApi.projectAgentDecideApproval({ workspaceId, approvalId, decision,
      ...(duration === 'once' || duration === 'task' || duration === 'denied' ? { duration } : {}) });
  }
  if (action.channel === 'project-agent:submit-input') {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const answerTo = typeof payload.answerTo === 'string' ? payload.answerTo : '';
    if (!text) return { ok: false, code: 'INVALID_INPUT' };
    return clientApi.projectAgentSubmitInput({ workspaceId, inputId: crypto.randomUUID(), text, surface: 'desktop', ...(answerTo ? { answerTo } : {}) });
  }
  if (action.channel === 'project-agent:start-familiarize') return clientApi.projectAgentStartFamiliarize({ workspaceId });
  if (action.channel === 'project-agent:confirm-result' && typeof payload.sessionId === 'string') {
    return clientApi.projectAgentConfirmResult({ workspaceId, sessionId: payload.sessionId });
  }
  if (action.channel === 'project-agent:accept-readme') return clientApi.projectAgentAcceptReadme({ workspaceId });
  if (action.channel === 'project-agent:retry' && typeof payload.turnId === 'string') return clientApi.projectAgentRetry({ workspaceId, turnId: payload.turnId });
  return { ok: false, code: 'INVALID_ACTION' };
}
