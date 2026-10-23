import type { I18nRuntime, TranslationKey } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';
import type { BotChatCard } from '../state/botConversationState';

const stateKeys: Readonly<Record<string, TranslationKey>> = {
  approved: 'projectAgent.chat.approvalReceipt.approved',
  denied: 'projectAgent.chat.approvalReceipt.denied',
  cancelled: 'projectAgent.chat.approvalReceipt.cancelled',
  expired: 'projectAgent.chat.approvalReceipt.expired',
};

export function ApprovalReceipt({ card, i18n, notice }: {
  readonly card: BotChatCard;
  readonly i18n: I18nRuntime;
  readonly notice?: TranslationKey;
}) {
  const state = stateKeys[card.resolution?.state ?? ''] ?? 'projectAgent.chat.approvalReceipt.closed';
  return <section className="bot-card bot-approval-receipt is-resolved" data-card-id={card.cardId}>
    <details>
      <summary>
        <PeerIcon name="history" size={14} />
        <span className="bot-approval-receipt-copy">
          <strong>{i18n.t(card.kind === 'plan_approval' ? 'projectAgent.chat.planDecisionRecord' : 'projectAgent.chat.approvalReceipt.title')}</strong>
          <span className="bot-approval-receipt-excerpt">{card.content}</span>
        </span>
        <span className="bot-approval-receipt-state">{i18n.t(state)}</span>
        <PeerIcon name="chevronRight" size={13} />
      </summary>
      <div className="bot-approval-receipt-content">
        {notice ? <p>{i18n.t(notice)}</p> : null}
        <pre>{card.content}</pre>
      </div>
    </details>
  </section>;
}
