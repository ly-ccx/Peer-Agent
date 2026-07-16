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
