import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotToolRound } from '../state/botConversationState';
import { agentProcessEntries } from './agentProcess';

export function AgentProcessView({
  rounds,
  i18n,
}: {
  readonly rounds: readonly BotToolRound[];
  readonly i18n: I18nRuntime;
}) {
  const entries = agentProcessEntries(rounds);
  return (
    <section className="bot-process" aria-label={i18n.t('projectAgent.chat.process')}>
      <h3>{i18n.t('projectAgent.chat.process')}</h3>
      {entries.map((entry, index) => (
        <details key={`${entry.name}-${index}`}>
          <summary>{entry.name}</summary>
          <pre>{entry.input}</pre>
          <pre>{entry.result}</pre>
        </details>
      ))}
    </section>
  );
}
