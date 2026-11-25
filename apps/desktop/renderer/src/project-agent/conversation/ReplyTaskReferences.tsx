import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';
import { ExecutorIcon, executorDisplayName } from '../ExecutorIcon';
import type { BotChatMessage } from '../state/botConversationState';
import { replyTaskReferences, type BotWorkIndex } from '../state/botWorkState';
import { workerStatus } from '../state/workerStatus';

export function ReplyTaskReferences({ messages, workIndex, i18n, onOpen }: {
  readonly messages: readonly BotChatMessage[];
  readonly workIndex: BotWorkIndex;
  readonly i18n: I18nRuntime;
  readonly onOpen: (sessionId: string) => void;
}) {
  const references = replyTaskReferences(messages, workIndex);
  if (!references.length) return null;
  const executor = executorDisplayName('peer', Boolean(i18n.locale?.startsWith('zh')));

  return (
    <div className="bot-reply-task-references bot-inline-worker-feed" role="group" aria-label={i18n.t('projectAgent.chat.work.heading')}>
      {references.map((row) => {
        const title = row.session?.title && row.session.title !== row.id
          ? row.session.title
          : i18n.t('projectAgent.chat.work.related');
        const status = workerStatus(row.session?.status ?? row.status, row.session?.followUp, i18n);
        return (
          <button
            type="button"
            className="bot-inline-worker-row"
            key={row.id}
            data-session-id={row.id}
            data-tone={status.tone}
            title={`${title} · ${status.text}`}
            onClick={() => onOpen(row.id)}
          >
            <ExecutorIcon className="bot-inline-worker-cli" title={executor} />
            <span className="bot-inline-worker-title">{title}</span>
            <span className="bot-inline-worker-status">{status.text}</span>
            <PeerIcon name="chevronRight" size={13} className="bot-inline-worker-arrow" />
          </button>
        );
      })}
    </div>
  );
}
