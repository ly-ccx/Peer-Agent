import type { ConversationDisplayRow } from './botConversationState';

/** A receipt may replace a provisional message ID, but it is still the same input. */
export const conversationRowKey = (row: ConversationDisplayRow) => row.type === 'message'
  ? row.message.kind === 'user_input' && row.message.inputId ? `input-${row.message.inputId}` : row.message.id
  : row.type === 'activity' ? `live-${row.activity.turnId}` : row.id;

/** Measured row geometry; offsets include each row's trailing spacing. */
export function conversationOffsets(keys: readonly string[], heights: ReadonlyMap<string, number>, estimate = 72): number[] {
  const offsets = [0];
  for (const key of keys) offsets.push(offsets.at(-1)! + (heights.get(key) ?? estimate));
  return offsets;
}

export function conversationRowAt(offsets: readonly number[], top: number): number {
  let low = 0, high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle]! <= top) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function conversationViewport(offsets: readonly number[], top: number, height: number) {
  const count = offsets.length - 1;
  if (count <= 200) return { start: 0, end: count, before: 0, after: 0 };
  const first = conversationRowAt(offsets, Math.max(0, top));
  const last = conversationRowAt(offsets, Math.max(0, top) + height);
  const start = Math.max(0, first - 20);
  const end = Math.min(count, Math.max(start + 80, last + 21));
  return { start, end, before: offsets[start]!, after: offsets[count]! - offsets[end]! };
}

export function restoreConversationOffset(keys: readonly string[], offsets: readonly number[], anchor: { key: string; delta: number }, origin = 0): number | null {
  const index = keys.indexOf(anchor.key);
  return index < 0 ? null : Math.max(0, origin + offsets[index]! - anchor.delta);
}
