import type { I18nRuntime } from '@zeus-atlas/i18n';
import type { AssistantAction, ChatMessage } from '@zeus-atlas/protocol';
import { isRecord } from '../../utils/records';

function actionPrompt(action: AssistantAction): string | null {
  const data = action.payload.data;
  if (typeof data === 'string' && data.trim()) return data;
  if (isRecord(data)) {
    const prompt = data.prompt ?? data.content ?? data.text ?? data.message;
    if (typeof prompt === 'string' && prompt.trim()) return prompt;
  }
  return null;
}

interface MessageRichPartsProps {
  readonly message: ChatMessage;
  readonly setDraft: (value: string) => void;
  readonly i18n: I18nRuntime;
}

export function MessageRichParts({ message, setDraft, i18n }: MessageRichPartsProps) {
  return (
    <>
      {message.sender || message.skillName ? (
        <div className="message-meta">
          {message.sender ? <span>{message.sender.name}</span> : null}
          {message.skillName ? <span>{message.skillName}</span> : null}
        </div>
      ) : null}
      {message.images && message.images.length > 0 ? (
        <div className="message-images" aria-label={i18n.t('chat.message.images')}>
          {message.images.map((image) => (
            <img key={image.url} src={image.url} alt="" />
          ))}
        </div>
      ) : null}
      {message.references && message.references.length > 0 ? (
        <details className="message-references">
          <summary>{i18n.t('chat.message.references')}</summary>
          {message.references.map((reference) => (
            <article key={`${reference.scopeId}-${reference.label}`}>
              <strong>{reference.label}</strong>
              <p>{reference.text}</p>
            </article>
          ))}
        </details>
      ) : null}
      {message.actions && message.actions.length > 0 ? (
        <div className="assistant-actions">
          {message.actions.map((action) => {
            const prompt = actionPrompt(action);
            return (
              <button
                key={action.id}
                type="button"
                disabled={!prompt}
                title={prompt ? action.label : i18n.t('chat.message.action.unsupported')}
                onClick={() => {
                  if (prompt) setDraft(prompt);
                }}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
