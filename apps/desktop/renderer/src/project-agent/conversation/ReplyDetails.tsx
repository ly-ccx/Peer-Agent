import type { I18nRuntime } from '@peer-agent/i18n';
import type { ConversationDisplayRow } from '../state/botConversationState';
import { replyWork, type BotWorkIndex } from '../state/botWorkState';
import { ReplyDetailsContext } from './ReplyContext';
import { BotProcess, type ProcessDisclosure } from './BotProcess';
import { CardDiagnostics } from './CardView';
import { DelegatedWork } from './DelegatedWork';
import { PeerIcon } from '../../ui/icons';
import { AgentProcessView } from '../drawer/AgentProcessView';

/** Uses the same live/history projection as the chat; it has no execution path. */
export function ReplyDetails({ row, workspaceId, botName, workIndex, i18n, onOpenEvidence, onOpenWork, disclosure }: {
  readonly row: ConversationDisplayRow | undefined;
  readonly workspaceId: string; readonly botName: string; readonly workIndex: BotWorkIndex;
  readonly i18n: I18nRuntime; readonly onOpenEvidence: (id: string) => void;
  readonly onOpenWork: (id: string) => void;
  readonly disclosure: ProcessDisclosure;
}) {
  if (!row || row.type === 'separator') return <p className="bot-reply-details-note">{i18n.t('projectAgent.chat.context.unavailable')}</p>;
  const message = row.type === 'message' ? row.message : undefined;
  const work = replyWork(message ?? { sources: [], marks: [], meta: {}, replyTo: row.activity?.replyTo ?? [] }, workIndex);
  const outcome = message?.cards.some(card => card.kind === 'agent_stopped') ? 'stopped'
    : message?.cards.some(card => card.kind === 'agent_unavailable') ? 'error' : undefined;
  return <div className="bot-reply-details" data-reply-id={message?.id ?? row.activity?.turnId}>
    <p className="bot-reply-details-note">{botName}{message?.createdAt ? ` · ${new Date(message.createdAt).toLocaleTimeString(i18n.locale, { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
    <ReplyDetailsContext workspaceId={workspaceId} message={message} i18n={i18n} onOpenEvidence={onOpenEvidence}>
      <BotProcess activity={row.activity} rounds={row.type === 'message' ? row.processRounds : undefined}
        i18n={i18n} disclosure={disclosure} outcome={outcome} />
      <DelegatedWork rows={work} botName={botName} i18n={i18n} onOpen={onOpenWork} disclosure={disclosure} />
      {message ? <CardDiagnostics cards={message.cards} i18n={i18n} /> : null}
      {row.type === 'message' && row.processRounds?.length ? <details className="bot-reply-rounds"
        open={disclosure.open.rounds ?? false} onToggle={event => {
          if (event.target === event.currentTarget) disclosure.toggle('rounds', event.currentTarget.open);
        }}><summary><span>{i18n.t('projectAgent.chat.context.rounds')}</span><PeerIcon name="chevronDown" size={12} /></summary>
        <AgentProcessView rounds={row.processRounds} i18n={i18n} />
      </details> : null}
    </ReplyDetailsContext>
  </div>;
}
