import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';
import type { BotChatMessage } from '../state/botConversationState';
import { replyTaskReferences, type BotWorkIndex } from '../state/botWorkState';

export function ReplyTaskReferences({ messages, workIndex, i18n, onOpen }: {
  readonly messages: readonly BotChatMessage[];
  readonly workIndex: BotWorkIndex;
  readonly i18n: I18nRuntime;
  readonly onOpen: (sessionId: string) => void;
}) {
  const references = replyTaskReferences(messages, workIndex);
  if (!references.length) return null;
  return <div className="bot-reply-task-references" role="group" aria-label={i18n.t('projectAgent.chat.work.heading')}>
    {references.map(row => {
      const title = row.session?.title && row.session.title !== row.id ? row.session.title : i18n.t('projectAgent.chat.work.related');
      const status = row.status ? i18n.t(`projectAgent.chat.sessionState.${row.status}`) : i18n.t('projectAgent.chat.work.unavailable');
      const reported = row.status ? i18n.t('projectAgent.chat.work.reportedState', { status }) : status;
      return <button type="button" className="bot-reply-bar" key={row.id} data-session-id={row.id}
        title={`${title} · ${reported}`} onClick={() => onOpen(row.id)}>
        <PeerIcon name="fileText" size={14} />
        <span className="bot-reply-bar-copy">
          <span className="bot-reply-bar-label">{title}</span>
          <span className="bot-reply-bar-excerpt">{reported}</span>
        </span>
        <PeerIcon name="chevronRight" size={14} />
      </button>;
    })}
  </div>;
}
