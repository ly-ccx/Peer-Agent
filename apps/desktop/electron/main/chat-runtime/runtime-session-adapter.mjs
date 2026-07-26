import { createRuntimeSessionController } from '@peer-agent/runtime-sdk';

function requireStreamId(streamId) {
  if (typeof streamId !== 'string' || !streamId.trim()) {
    throw new TypeError('Desktop Runtime session requires a non-empty streamId');
  }
  return streamId.trim();
}

function resolveSessionId(streamId, conversationId) {
  return conversationId === null || conversationId === undefined || conversationId === ''
    ? streamId
    : String(conversationId);
}

export function createDesktopRuntimeSessionAdapter({
  controller = createRuntimeSessionController(),
} = {}) {
  const activeTurns = new Map();

  function reclaimStaleActiveTurn(sessionId, { reason = 'stale_active_turn_reclaimed' } = {}) {
    // Prefer tracked stream map so settleStream clears Desktop-side ownership first.
    for (const [otherStreamId, turn] of activeTurns.entries()) {
      if (turn?.sessionId === sessionId) {
        settleStream(otherStreamId, 'aborted', reason);
      }
    }
    // Controller may still hold a running turn after map drift; force-cancel so resume can proceed.
    const snapshot = controller.get(sessionId);
    if (snapshot?.status === 'running' || snapshot?.activeTurn) {
      try {
        controller.cancel(sessionId, reason);
      } catch {
        // ignore double-cancel races; the goal is only to free the lock
      }
    }
  }

  function startStream({ streamId, conversationId = null } = {}) {
    const normalizedStreamId = requireStreamId(streamId);
    if (activeTurns.has(normalizedStreamId)) {
      // Same stream id re-entry: reclaim instead of hard-failing and blocking Goal resume.
      settleStream(normalizedStreamId, 'aborted', 'stale_stream_replaced');
    }

    const sessionId = resolveSessionId(normalizedStreamId, conversationId);
    const existing = controller.get(sessionId);
    if (existing?.status === 'running' || existing?.activeTurn) {
      reclaimStaleActiveTurn(sessionId, {
        reason: 'stale_active_turn_reclaimed',
      });
    }

    const sessionAfterReclaim = controller.get(sessionId);
    const turn = sessionAfterReclaim
      ? controller.resume({ sessionId, streamId: normalizedStreamId })
      : controller.start({
          sessionId,
          ...(conversationId === null || conversationId === undefined || conversationId === ''
            ? {}
            : { conversationId: String(conversationId) }),
          streamId: normalizedStreamId,
        });
    activeTurns.set(normalizedStreamId, turn);
    return turn;
  }

  function settleStream(streamId, status, reason) {
    const normalizedStreamId = requireStreamId(streamId);
    const turn = activeTurns.get(normalizedStreamId);
    if (!turn) return null;
    activeTurns.delete(normalizedStreamId);

    let snapshot;
    if (status === 'done' || status === 'completed') {
      snapshot = turn.complete();
    } else if (status === 'aborted' || status === 'cancelled') {
      snapshot = turn.cancel(reason || 'user_aborted');
    } else {
      snapshot = turn.fail(reason || status || 'stream_error');
    }
    if (!turn.conversationId) controller.delete(turn.sessionId);
    return snapshot;
  }

  return {
    startStream,
    settleStream,
    cancelStream(streamId, reason = 'user_aborted') {
      return settleStream(streamId, 'aborted', reason);
    },
    failStream(streamId, reason = 'stream_error') {
      return settleStream(streamId, 'error', reason);
    },
    getSession(sessionId) {
      return controller.get(String(sessionId));
    },
    getActiveTurn(streamId) {
      return activeTurns.get(String(streamId)) ?? null;
    },
    listSessions() {
      return controller.list();
    },
  };
}
