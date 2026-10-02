import { PeerIcon } from '../../ui/icons';
export function QuoteChip({
  text,
  removeLabel,
  onRemove,
}: {
  readonly text: string;
  readonly removeLabel: string;
  readonly onRemove: () => void;
}) {
  return (
    <p className="bot-quote-chip">
      <PeerIcon name="back" size={15} />
      <span title={text}>{text}</span>
      <button type="button" aria-label={removeLabel} onClick={onRemove}>
        <PeerIcon name="close" size={14} />
      </button>
    </p>
  );
}
