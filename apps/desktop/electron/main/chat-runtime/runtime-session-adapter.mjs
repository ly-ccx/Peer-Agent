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

  function startStream({ streamId, conversationId = null } = {}) {
    const normalizedStreamId = requireStreamId(streamId);
    if (activeTurns.has(normalizedStreamId)) {
      throw new Error(`Desktop stream ${normalizedStreamId} already has an active Runtime turn`);
    }

    const sessionId = resolveSessionId(normalizedStreamId, conversationId);
    const existing = controller.get(sessionId);
    const turn = existing
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
