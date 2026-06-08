import type { I18nRuntime, TranslationKey } from '@zeus-atlas/i18n';
import type { AgentSummary } from '../../state/useAgentList';
import type { CloudChatRuntime } from '../../state/cloudChatRuntimeTypes';
import { ChatComposer } from './ChatComposer';

const suggestionKeys = [
  'chat.empty.suggestion.focus',
  'chat.empty.suggestion.todo',
  'chat.empty.suggestion.minutes',
] as const satisfies readonly TranslationKey[];

export function EmptyChatCommandSurface({
  activeAgent,
  agents,
  draft,
  i18n,
  onSelectAgent,
  runtime,
  setDraft,
}: {
  readonly activeAgent?: AgentSummary | null;
  readonly agents?: readonly AgentSummary[];
  readonly draft: string;
  readonly i18n: I18nRuntime;
  readonly onSelectAgent?: (agent: AgentSummary) => void;
  readonly runtime: CloudChatRuntime;
  readonly setDraft: (draft: string) => void;
}) {
  return (
    <div className="empty-command-surface">
      <div className="empty-command-inner">
        <h1>{i18n.t('chat.empty.title')}</h1>
        <ChatComposer
          activeAgent={activeAgent}
          agents={agents}
          autoFocus
          draft={draft}
          i18n={i18n}
          onSelectAgent={onSelectAgent}
          runtime={runtime}
          setDraft={setDraft}
          variant="empty"
        />
        <div className="empty-command-suggestions" aria-label={i18n.t('chat.empty.suggestionsLabel')}>
          {suggestionKeys.map((key) => {
            const suggestion = i18n.t(key);
            return (
              <button key={key} type="button" onClick={() => setDraft(suggestion)}>
                <span>{suggestion}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
