import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';
import { ExecutorIcon, executorDisplayName } from '../ExecutorIcon';
import type { BotWorkRow } from '../state/botWorkState';
import { workerStatus } from '../state/workerStatus';

export function ReplyTaskReferences({ rows, i18n, onOpen }: {
  readonly rows: readonly BotWorkRow[];
  readonly i18n: I18nRuntime;
  readonly onOpen: (sessionId: string) => void;
}) {
  if (!rows.length) return null;
  const executor = executorDisplayName('peer', Boolean(i18n.locale?.startsWith('zh')));

  return (
    <div className="bot-reply-task-references bot-inline-worker-feed" role="group" aria-label={i18n.t('projectAgent.chat.work.heading')}>
      {rows.map((row) => {
        const title = row.session?.title && row.session.title !== row.id
          ? row.session.title
          : i18n.t('projectAgent.chat.work.related');
        const status = workerStatus(row.session ?? { status: row.status }, i18n);
        const showDot = status.tone !== 'muted';
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
            <span className="bot-inline-worker-status">
              {showDot ? <span className="bot-inline-worker-dot" aria-hidden="true" /> : null}
              <span>{status.text}</span>
            </span>
            <PeerIcon name="chevronRight" size={13} className="bot-inline-worker-arrow" />
          </button>
        );
      })}
    </div>
  );
}
