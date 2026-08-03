import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_INTERVAL_MS = 250;

/**
 * Main-owned request/ack bridge for revealing a conversation-bound Browser workbench.
 * The renderer owns visible Workbench state, while the main-process browser registry is
 * the source of truth for whether the requested conversation is actually controllable.
 */
export function createBrowserPanelRevealCoordinator({
  broadcast,
  isBrowserReady = () => true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
} = {}) {
  if (typeof broadcast !== 'function') throw new TypeError('broadcast must be a function');
  if (typeof isBrowserReady !== 'function') throw new TypeError('isBrowserReady must be a function');
  const pending = new Map();
  const pendingByConversation = new Map();

  function ensureBrowserReady({ conversationId, focus = true, timeoutMs: requestTimeoutMs } = {}) {
    if (typeof conversationId !== 'string' || !conversationId.trim()) {
      return Promise.reject(new Error('conversationId is required'));
    }
    const existing = pendingByConversation.get(conversationId);
    if (existing) return existing.promise;
    const requestId = randomUUID();
    const effectiveTimeout = Math.max(100, Number(requestTimeoutMs) || timeoutMs);
    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const request = {
      requestId,
      conversationId,
      focus: focus !== false,
      accepted: false,
      acceptedPayload: null,
      resolve: resolveRequest,
      reject: rejectRequest,
      timeoutTimer: null,
      retryTimer: null,
      promise,
    };

    const clearRequest = () => {
      clearTimeout(request.timeoutTimer);
      clearInterval(request.retryTimer);
      pending.delete(requestId);
      pendingByConversation.delete(conversationId);
    };
    const finishIfReady = () => {
      if (!request.accepted || !isBrowserReady(conversationId)) return false;
      clearRequest();
      const payload = request.acceptedPayload || {};
      request.resolve({
        status: payload.status || 'opened',
        sessionId: payload.sessionId || null,
        focused: payload.focused !== false,
      });
      return true;
    };
    const sendReveal = () => {
      if (finishIfReady()) return;
      broadcast('browser:panel-reveal-request', {
        requestId,
        conversationId,
        focus: request.focus,
        sessionPolicy: 'reuse-or-create',
      });
    };

    request.timeoutTimer = setTimeout(() => {
      clearRequest();
      rejectRequest(new Error('Timed out while opening the Browser workspace'));
    }, effectiveTimeout);
    request.retryTimer = setInterval(sendReveal, Math.max(25, Number(retryIntervalMs) || DEFAULT_RETRY_INTERVAL_MS));
    request.finishIfReady = finishIfReady;
    request.clear = clearRequest;
    pending.set(requestId, request);
    pendingByConversation.set(conversationId, request);
    sendReveal();
    return promise;
  }

  function acknowledge(payload = {}) {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const request = pending.get(requestId);
    if (!request) return false;
    if (payload.conversationId !== request.conversationId) return false;
    if (payload.ok === false) {
      request.clear();
      request.reject(new Error(payload.error || 'Renderer could not open the Browser workspace'));
      return true;
    }
    request.accepted = true;
    request.acceptedPayload = payload;
    request.finishIfReady();
    return true;
  }

  function dispose() {
    for (const request of pending.values()) {
      request.clear();
      request.reject(new Error('Browser workspace reveal service stopped'));
    }
    pending.clear();
    pendingByConversation.clear();
  }

  return Object.freeze({ ensureBrowserReady, acknowledge, dispose });
}
