import { useContext, useState } from 'react';
import type { InteractionToolView } from '../../state/interactionToolView';
import { MarkdownMessage } from '../markdown/MarkdownMessage';
import { InteractionAnsweredContext, InteractionContext } from './interactionContext';

export function InteractionToolCard({
  view,
  className,
}: {
  readonly view: InteractionToolView;
  readonly className?: string;
}) {
  // 点击选项后的即时乐观反馈：消息级 answeredText 要等回复消息进入列表才会出现，
  // 中间有一拍延迟，用本地 state 先锁住，避免重复点击。
  const [optimisticAnswer, setOptimisticAnswer] = useState<string | null>(null);
  const interaction = useContext(InteractionContext);
  // 消息级事实：这张卡之后是否已有 user 回复（点选项或输入框自由输入都算）。
  const repliedText = useContext(InteractionAnsweredContext);

  const selectedText = repliedText ?? optimisticAnswer;
  const answered = selectedText !== null;
  const isStreaming = interaction?.isStreaming ?? false;
  // 等待回复：有回调、未在生成中、且尚未被回复。已回复后一律不可再点。
  const waiting = Boolean(interaction) && !isStreaming && !answered;

  const select = (text: string) => {
    if (!waiting || !interaction) return;
    setOptimisticAnswer(text);
    interaction.onSelectOption(text);
  };

  const normalize = (s: string) => s.trim();
  const matchesSelected = (option: string) =>
    selectedText !== null && normalize(option) === normalize(selectedText);

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
          {view.options.map((option, idx) => {
            const selected = matchesSelected(option);
            const optionClasses = [
              'interaction-option-button',
              selected ? 'selected' : '',
            ].filter(Boolean).join(' ');
            return (
              <button
                key={`${idx}-${option}`}
                type="button"
                className={optionClasses}
                disabled={!waiting}
                aria-pressed={selected}
                onClick={() => select(option)}
              >
                <span className="interaction-option-text">{option}</span>
                {selected ? <span className="interaction-option-badge">已选</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="interaction-hint">
        {answered
          ? '已回复'
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
