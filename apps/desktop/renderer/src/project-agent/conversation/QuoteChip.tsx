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
      <span>{text}</span>
      <button type="button" aria-label={removeLabel} onClick={onRemove}>
        <PeerIcon name="close" size={12} />
      </button>
    </p>
  );
}
