import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotToolRound } from '../state/botConversationState';
import { agentProcessEntries, toolPreviewText, toolStepStatus } from './agentProcess';
import { PeerIcon } from '../../ui/icons';

export function AgentProcessView({
  rounds,
  i18n,
  outcome,
}: {
  readonly rounds: readonly BotToolRound[];
  readonly i18n: I18nRuntime;
  readonly outcome?: 'stopped' | 'error';
}) {
  const entries = agentProcessEntries(rounds);
  return (
    <section className="bot-process" aria-label={i18n.t('projectAgent.chat.process')}>
      <h3>{i18n.t('projectAgent.chat.process')}</h3>
      {entries.length === 0 ? <p className="bot-process-empty">{i18n.t('projectAgent.process.empty')}</p> : null}
      {entries.map((entry, index) => (
        <div className="bot-process-entry" key={`${entry.name}-${index}`} data-status={entry.status}>
          <div className="bot-process-heading"><PeerIcon name={entry.icon} size={15} />
            <span>{i18n.t(entry.labelKey)}</span><span className="bot-process-status">{i18n.t(entry.name === 'post_reply' && entry.status === 'done' ? 'projectAgent.process.sent' : `projectAgent.process.${toolStepStatus(entry.status, entry.resultPreview, outcome)}`)}</span>
          </div>
          {entry.summary ? <p className="bot-process-summary">{entry.summary}</p> : null}
          {entry.count !== undefined ? <p className="bot-process-summary">{i18n.t('projectAgent.process.count', { count: entry.count })}</p> : null}
          <details className="bot-process-technical">
            <summary><PeerIcon name="chevronRight" size={12} />{i18n.t('projectAgent.process.technical')}</summary>
            <p>{entry.name}</p>
            <span>{i18n.t('projectAgent.process.input')}{entry.inputPreview.redacted ? ` · ${i18n.t('projectAgent.process.redacted')}` : ''}{entry.inputPreview.truncated ? ` · ${i18n.t('projectAgent.process.truncated')}` : ''}</span><pre tabIndex={0}>{toolPreviewText(entry.inputPreview, { empty: i18n.t('projectAgent.process.noOutput'), limit: i18n.t('projectAgent.process.previewLimit') })}</pre>
            <span>{i18n.t('projectAgent.process.result')}{entry.resultPreview.redacted ? ` · ${i18n.t('projectAgent.process.redacted')}` : ''}{entry.resultPreview.truncated ? ` · ${i18n.t('projectAgent.process.truncated')}` : ''}</span><pre tabIndex={0}>{toolPreviewText(entry.resultPreview, { empty: i18n.t('projectAgent.process.noOutput'), limit: i18n.t('projectAgent.process.previewLimit') })}</pre>
          </details>
        </div>
      ))}
    </section>
  );
}
