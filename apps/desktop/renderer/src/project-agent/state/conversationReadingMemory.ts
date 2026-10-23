export interface ReadingAnchor { readonly key: string; readonly delta: number; readonly messageId?: string }
export interface ReadingSnapshot {
  readonly following: boolean; readonly top: number; readonly anchor: ReadingAnchor | null;
  readonly heights: readonly (readonly [string, number])[];
}

/** Bounded session-only geometry. Contains IDs and measurements, never conversation or permission facts. */
export function createConversationReadingMemory(limit = 40) {
  const snapshots = new Map<string, ReadingSnapshot>();
  return {
    read(id: string) { return snapshots.get(id); },
    save(id: string, snapshot: ReadingSnapshot) {
      snapshots.delete(id); snapshots.set(id, { ...snapshot, heights: snapshot.heights.slice(0, 160) });
      while (snapshots.size > limit) snapshots.delete(snapshots.keys().next().value!);
    },
  };
}
export const conversationReadingMemory = createConversationReadingMemory();
