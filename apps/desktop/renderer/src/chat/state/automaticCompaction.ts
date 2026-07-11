import { conversationStore } from './conversationStore.ts';

/**
 * Schedule one automatic compaction for the conversation that produced the suggestion.
 * The target id is captured by value and never re-read from the currently active view.
 */
export function scheduleAutomaticCompaction(
  conversationId: string,
  runCompaction: (conversationId: string) => Promise<unknown>,
  defer: (callback: () => void) => void = (callback) => setTimeout(callback, 0),
): void {
  if (!conversationId || conversationStore.getSnapshot(conversationId).autoCompacting) return;
  conversationStore.setState(conversationId, { autoCompacting: true });
  defer(() => {
    void runCompaction(conversationId)
      .catch((error) => {
        console.error('[chat] automatic compaction failed:', error);
      })
      .finally(() => {
        conversationStore.setState(conversationId, { autoCompacting: false });
      });
  });
}
