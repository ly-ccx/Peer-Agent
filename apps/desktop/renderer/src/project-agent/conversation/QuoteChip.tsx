import { PeerIcon } from '../../ui/icons';
export function QuoteChip({
  text,
  source,
  removeLabel,
  onRemove,
}: {
  readonly text: string;
  readonly source: string;
  readonly removeLabel: string;
  readonly onRemove: () => void;
}) {
  return (
    <div className="bot-quote-chip">
      <span className="bot-reply-bar-copy">
        <span className="bot-reply-bar-label">{source}</span>
        <span className="bot-reply-bar-excerpt" title={text}>{text}</span>
      </span>
      <button type="button" aria-label={removeLabel} onClick={onRemove}>
        <PeerIcon name="close" size={14} />
      </button>
    </div>
  );
}
