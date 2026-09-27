import type { I18nRuntime } from '@peer-agent/i18n';
import { useState } from 'react';
import { clientApi } from '../../clientApi';
import type { BotChatCard, BotChatCardAction } from '../state/botConversationState';

/**
 * 卡片动作只走已经约定的两条 IPC。
 * 还没有通道的签收、README 和重试缝只显示，不另开调用。
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
  const resolved = card.resolvedState === 'resolved';
  return (
    <section className={`bot-card${resolved ? ' is-resolved' : ''}`} data-card-id={card.cardId}>
      <p>{card.content}</p>
      {resolved || !card.actions?.length ? null : (
        <div className="bot-card-actions">
          {card.actions.map((action, index) => (
            <button
              key={`${action.id}-${index}`}
              type="button"
              disabled={busy}
              onClick={() => {
                void runCardAction(workspaceId, action, setBusy, onDone);
              }}
            >
              {actionLabel(action, i18n)}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function actionLabel(action: BotChatCardAction, i18n: I18nRuntime): string {
  const text = typeof action.payload?.text === 'string' ? action.payload.text.trim() : '';
  if (text) return text;
  if (action.id === 'approve') return i18n.t('projectAgent.chat.approve');
  if (action.id === 'reject') return i18n.t('projectAgent.chat.reject');
  if (action.id === 'answer') return i18n.t('projectAgent.chat.answer');
  return action.id;
}

async function runCardAction(
  workspaceId: string,
  action: BotChatCardAction,
  setBusy: (busy: boolean) => void,
  onDone?: () => void,
) {
  if (action.channel === 'project-agent:decide-approval') {
    const approvalId = typeof action.payload?.approvalId === 'string' ? action.payload.approvalId : '';
    const decision = action.payload?.decision;
    if (!approvalId || (decision !== 'approve' && decision !== 'reject' && decision !== 'deny')) return;
    setBusy(true);
    try {
      await clientApi.projectAgentDecideApproval({ workspaceId, approvalId, decision });
      onDone?.();
    } finally {
      setBusy(false);
    }
    return;
  }
  if (action.channel === 'project-agent:submit-input') {
    const text = typeof action.payload?.text === 'string' ? action.payload.text.trim() : '';
    if (!text) return;
    setBusy(true);
    try {
      await clientApi.projectAgentSubmitInput({
        workspaceId,
        inputId: crypto.randomUUID(),
        text,
        surface: 'desktop',
      });
      onDone?.();
    } finally {
      setBusy(false);
    }
  }
}
