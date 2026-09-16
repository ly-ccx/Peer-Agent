import type { ContextAccountingSnapshot } from '@peer-agent/protocol';

/** Reject delayed snapshots without estimating context usage in presentation. */
export function acceptAccountingSnapshot(
  previous: ContextAccountingSnapshot | null,
  next: ContextAccountingSnapshot,
): ContextAccountingSnapshot {
  if (previous == null || previous.modelKey !== next.modelKey) return next;
  if (next.contentRevision < previous.contentRevision) return previous;
  if (
    next.contentRevision === previous.contentRevision
    && next.revision <= previous.revision
  ) return previous;
  return next;
}
