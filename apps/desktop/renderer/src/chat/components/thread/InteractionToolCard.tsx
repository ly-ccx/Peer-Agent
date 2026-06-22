import { useContext, useState } from 'react';
import type { InteractionToolView } from '../../state/interactionToolView';
import { MarkdownMessage } from '../markdown/MarkdownMessage';
import { InteractionContext } from './interactionContext';

export function InteractionToolCard({
  view,
  className,
}: {
  readonly view: InteractionToolView;
  readonly className?: string;
}) {
  const [answered, setAnswered] = useState(false);
  const interaction = useContext(InteractionContext);
  const waiting = Boolean(interaction) && !(interaction?.isStreaming ?? false) && !answered;
  const select = (text: string) => {
    if (!waiting || !interaction) return;
    setAnswered(true);
    interaction.onSelectOption(text);
  };

  const classes = [
    'tool-call-card',
    'interaction-card',
    waiting ? 'waiting' : 'answered',
    className ?? '',
  ].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <div className="interaction-question">
        <MarkdownMessage content={view.question} />
      </div>
      {view.options.length > 0 ? (
        <div className="interaction-options">
          {view.options.map((option, idx) => (
            <button
              key={`${idx}-${option}`}
              type="button"
              className="interaction-option-button"
              disabled={!waiting}
              onClick={() => select(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <div className="interaction-hint">
        {answered
          ? '已发送你的选择…'
          : waiting
            ? '等待你的输入：点击上方选项，或直接在下方输入框回复。'
            : '处理中…'}
      </div>
      {view.note ? (
        <div className="interaction-note">
          <MarkdownMessage content={view.note} />
        </div>
      ) : null}
    </div>
  );
}
