import { conversationStore } from './conversationStore.ts';

/**
 * Register and project a compaction start in the conversation bucket that owns the job.
 * The active view is intentionally not an input: background compaction must never write
 * through a setter bound to whichever conversation happens to be visible.
 */
export function beginConversationCompaction(
  conversationId: string,
  streamId: string,
  startedAt: number,
): void {
  conversationStore.routeStream(streamId, conversationId);
  conversationStore.setState(conversationId, {
    streamId,
    turnStartedAt: startedAt,
    compactionState: { phase: 'running', percent: null, streamId, startedAt },
  });
}

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
