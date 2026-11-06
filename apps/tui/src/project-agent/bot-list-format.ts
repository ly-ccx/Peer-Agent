/** One quiet line of list text. Collapses whitespace and keeps the timestamp from colliding with the preview. */
export function clipBotLine(value: string, width: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (width <= 0 || text.length <= width) return text;
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

/** `2026-11-05T12:36:00Z` becomes `11-05 12:36`. Unrecognized values stay short and unwrapped. */
export function formatBotWhen(value: string): string {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return clipBotLine(value, 16);
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}
