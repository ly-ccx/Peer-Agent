import type {
  ContextAccountingPhase,
  ContextAccountingSnapshot,
  ContextCountCapability,
} from '@peer-agent/protocol';

export type ContextAccountingIdentity = Readonly<{
  conversationId: string;
  contentRevision: number;
  modelKey: string;
}>;

export type ContextAccountingLifecycle = Readonly<{
  stable(
    snapshot: ContextAccountingSnapshot,
    phase?: ContextAccountingPhase,
    options?: Readonly<{
      pendingUncountedChanges?: boolean;
      pendingContentChars?: number;
    }>,
  ): ContextAccountingSnapshot;
  streamPreview(delta: string): ContextAccountingSnapshot;
  markPending(
    phase: ContextAccountingPhase,
    addedContentChars?: number,
  ): ContextAccountingSnapshot;
  invalidateModel(input: Readonly<{
    identity: ContextAccountingIdentity;
    contextWindow: number | null;
    countCapability: ContextCountCapability;
  }>): ContextAccountingSnapshot;
  current(): ContextAccountingSnapshot;
}>;

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}
function normalizeWindow(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

export function createUnknownContextAccountingSnapshot(input: Readonly<{
  identity: ContextAccountingIdentity;
  contextWindow: number | null;
  countCapability: ContextCountCapability;
  phase?: ContextAccountingPhase;
  revision?: number;
  compactionEpoch?: number;
  pendingUncountedChanges?: boolean;
  now?: number;
}>): ContextAccountingSnapshot {
  const contextWindow = normalizeWindow(input.contextWindow);
  return Object.freeze({
    version: 1,
    conversationId: input.identity.conversationId,
    contentRevision: nonNegativeInteger(input.identity.contentRevision),
    modelKey: input.identity.modelKey,
    revision: nonNegativeInteger(input.revision),
    phase: input.phase ?? 'restored',
    compactionEpoch: nonNegativeInteger(input.compactionEpoch),
    contextWindow,
    inputBudget: contextWindow,
    compactionThresholdTokens: contextWindow == null
      ? null
      : Math.floor(contextWindow * 0.8),
    authoritativeInputTokens: null,
    percent: null,
    pressureSource: 'unknown',
    pendingUncountedChanges: input.pendingUncountedChanges ?? false,
    pendingContentChars: 0,
    countCapability: input.countCapability,
    counterStatus: 'active',
    updatedAt: input.now ?? Date.now(),
  });
}

export function isContextAccountingSnapshotCurrent(
  snapshot: ContextAccountingSnapshot | null | undefined,
  identity: ContextAccountingIdentity,
): snapshot is ContextAccountingSnapshot {
  return Boolean(
    snapshot
    && snapshot.version === 1
    && snapshot.conversationId === identity.conversationId
    && snapshot.contentRevision === identity.contentRevision
    && snapshot.modelKey === identity.modelKey,
  );
}

/**
 * Owns accounting revision order and pending-content transitions for one host
 * turn. Both Desktop and TUI publish this exact snapshot; presentation never
 * estimates or merges token counts.
 */
export function createContextAccountingLifecycle(input: Readonly<{
  initialSnapshot: ContextAccountingSnapshot;
  onSnapshot?: (snapshot: ContextAccountingSnapshot) => void;
  now?: () => number;
}>): ContextAccountingLifecycle {
  const now = input.now ?? Date.now;
  let revision = nonNegativeInteger(input.initialSnapshot.revision);
  let snapshot = input.initialSnapshot;

  const publish = (
    base: ContextAccountingSnapshot,
    phase: ContextAccountingPhase,
    pendingUncountedChanges: boolean,
    pendingContentChars: number,
  ): ContextAccountingSnapshot => {
    snapshot = Object.freeze({
      ...base,
      revision: ++revision,
      phase,
      pendingUncountedChanges,
      pendingContentChars: nonNegativeInteger(pendingContentChars),
      updatedAt: now(),
    });
    input.onSnapshot?.(snapshot);
    return snapshot;
  };

  const markPending = (
    phase: ContextAccountingPhase,
    addedContentChars = 0,
  ): ContextAccountingSnapshot => publish(
    snapshot,
    phase,
    true,
    snapshot.pendingContentChars + nonNegativeInteger(addedContentChars),
  );

  return Object.freeze({
    stable(base, phase = base.phase, options = {}) {
      return publish(
        base,
        phase,
        options.pendingUncountedChanges ?? base.pendingUncountedChanges,
        options.pendingContentChars
          ?? (base.pendingUncountedChanges ? base.pendingContentChars : 0),
      );
    },
    streamPreview(delta) {
      return markPending(
        'stream_preview',
        typeof delta === 'string' ? delta.length : 0,
      );
    },
    markPending,
    invalidateModel(next) {
      const unknown = createUnknownContextAccountingSnapshot({
        identity: next.identity,
        contextWindow: next.contextWindow,
        countCapability: next.countCapability,
        phase: 'model_changed',
        revision,
        pendingUncountedChanges: snapshot.pendingUncountedChanges,
        now: now(),
      });
      return publish(unknown, 'model_changed', unknown.pendingUncountedChanges, 0);
    },
    current() {
      return snapshot;
    },
  });
}
