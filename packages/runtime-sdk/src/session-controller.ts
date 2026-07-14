import type {
  RuntimeSessionController,
  RuntimeSessionControllerOptions,
  RuntimeSessionResumeOptions,
  RuntimeSessionSnapshot,
  RuntimeSessionStartOptions,
  RuntimeSessionTurnHandle,
  RuntimeSessionTurnSnapshot,
  RuntimeTurnStatus,
} from './session-contracts.ts';

type ActiveTurn = {
  readonly snapshot: RuntimeSessionTurnSnapshot;
  readonly controller: AbortController;
  detachExternalSignal?: () => void;
};

type SessionRecord = {
  readonly sessionId: string;
  readonly conversationId?: string;
  readonly createdAt: string;
  updatedAt: string;
  nextTurnIndex: number;
  activeTurn?: ActiveTurn;
  lastTurn?: RuntimeSessionTurnSnapshot;
};

function normalizeReason(reason: unknown, fallback = 'aborted'): string {
  return typeof reason === 'string' && reason.trim() ? reason.trim() : fallback;
}

function snapshotSession(record: SessionRecord): RuntimeSessionSnapshot {
  return {
    sessionId: record.sessionId,
    ...(record.conversationId ? { conversationId: record.conversationId } : {}),
    status: record.activeTurn ? 'running' : 'idle',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nextTurnIndex: record.nextTurnIndex,
    ...(record.activeTurn ? { activeTurn: { ...record.activeTurn.snapshot } } : {}),
    ...(record.lastTurn ? { lastTurn: { ...record.lastTurn } } : {}),
  };
}

export function createRuntimeSessionController(
  options: RuntimeSessionControllerOptions = {},
): RuntimeSessionController {
  const sessions = new Map<string, SessionRecord>();
  const now = options.now ?? (() => new Date().toISOString());
  const createTurnId = options.createTurnId
    ?? ((sessionId: string, turnIndex: number) => `${sessionId}:turn:${turnIndex}`);

  const publish = (record: SessionRecord): RuntimeSessionSnapshot => {
    const snapshot = snapshotSession(record);
    options.onChange?.(snapshot);
    return snapshot;
  };

  const finishTurn = (
    record: SessionRecord,
    activeTurn: ActiveTurn,
    status: Exclude<RuntimeTurnStatus, 'running'>,
    reason?: string,
    abortSignal = false,
  ): RuntimeSessionSnapshot => {
    if (record.activeTurn !== activeTurn) return snapshotSession(record);

    activeTurn.detachExternalSignal?.();
    if (abortSignal && !activeTurn.controller.signal.aborted) {
      activeTurn.controller.abort(reason);
    }

    const completedAt = now();
    record.activeTurn = undefined;
    record.lastTurn = {
      ...activeTurn.snapshot,
      status,
      completedAt,
      ...(reason ? { reason } : {}),
    };
    record.updatedAt = completedAt;
    return publish(record);
  };

  const beginTurn = (
    record: SessionRecord,
    options: RuntimeSessionResumeOptions,
    startedAt = now(),
  ): RuntimeSessionTurnHandle => {
    if (record.activeTurn) {
      throw new Error(`Runtime session ${record.sessionId} already has an active turn`);
    }

    const turnIndex = record.nextTurnIndex;
    const turnId = createTurnId(record.sessionId, turnIndex);
    const controller = new AbortController();
    const turnSnapshot: RuntimeSessionTurnSnapshot = {
      turnId,
      turnIndex,
      ...(options.streamId ? { streamId: options.streamId } : {}),
      status: 'running',
      startedAt,
    };
    const activeTurn: ActiveTurn = { snapshot: turnSnapshot, controller };

    record.activeTurn = activeTurn;
    record.nextTurnIndex = turnIndex + 1;
    record.updatedAt = startedAt;

    const cancelFromExternalSignal = () => {
      finishTurn(
        record,
        activeTurn,
        'cancelled',
        normalizeReason(options.signal?.reason, 'host_aborted'),
        true,
      );
    };
    if (options.signal) {
      if (options.signal.aborted) {
        cancelFromExternalSignal();
      } else {
        options.signal.addEventListener('abort', cancelFromExternalSignal, { once: true });
        activeTurn.detachExternalSignal = () => {
          options.signal?.removeEventListener('abort', cancelFromExternalSignal);
        };
      }
    }

    if (record.activeTurn === activeTurn) publish(record);

    return {
      sessionId: record.sessionId,
      ...(record.conversationId ? { conversationId: record.conversationId } : {}),
      turnId,
      turnIndex,
      ...(options.streamId ? { streamId: options.streamId } : {}),
      signal: controller.signal,
      complete: () => finishTurn(record, activeTurn, 'completed'),
      fail: (reason) => finishTurn(record, activeTurn, 'failed', reason, true),
      cancel: (reason) => finishTurn(
        record,
        activeTurn,
        'cancelled',
        normalizeReason(reason),
        true,
      ),
      snapshot: () => snapshotSession(record),
    };
  };

  return {
    start(startOptions: RuntimeSessionStartOptions): RuntimeSessionTurnHandle {
      if (sessions.has(startOptions.sessionId)) {
        throw new Error(`Runtime session ${startOptions.sessionId} already exists`);
      }
      const startedAt = now();
      const record: SessionRecord = {
        sessionId: startOptions.sessionId,
        ...(startOptions.conversationId
          ? { conversationId: startOptions.conversationId }
          : {}),
        createdAt: startedAt,
        updatedAt: startedAt,
        nextTurnIndex: 0,
      };
      sessions.set(record.sessionId, record);
      return beginTurn(record, startOptions, startedAt);
    },

    resume(resumeOptions: RuntimeSessionResumeOptions): RuntimeSessionTurnHandle {
      const record = sessions.get(resumeOptions.sessionId);
      if (!record) {
        throw new Error(`Runtime session ${resumeOptions.sessionId} does not exist`);
      }
      return beginTurn(record, resumeOptions);
    },

    cancel(sessionId: string, reason = 'aborted'): RuntimeSessionSnapshot | null {
      const record = sessions.get(sessionId);
      if (!record) return null;
      if (!record.activeTurn) return snapshotSession(record);
      return finishTurn(
        record,
        record.activeTurn,
        'cancelled',
        normalizeReason(reason),
        true,
      );
    },

    get(sessionId: string): RuntimeSessionSnapshot | null {
      const record = sessions.get(sessionId);
      return record ? snapshotSession(record) : null;
    },

    list(): readonly RuntimeSessionSnapshot[] {
      return [...sessions.values()].map(snapshotSession);
    },

    delete(sessionId: string): boolean {
      const record = sessions.get(sessionId);
      if (!record || record.activeTurn) return false;
      return sessions.delete(sessionId);
    },
  };
}
