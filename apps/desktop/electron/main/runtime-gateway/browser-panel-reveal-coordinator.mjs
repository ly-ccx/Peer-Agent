import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Main-owned request/ack bridge for revealing a conversation-bound Browser workbench.
 * The renderer remains the owner of visible Workbench and BrowserSession state.
 */
export function createBrowserPanelRevealCoordinator({
  broadcast,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof broadcast !== 'function') throw new TypeError('broadcast must be a function');
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
    const timer = setTimeout(() => {
      pending.delete(requestId);
      pendingByConversation.delete(conversationId);
      rejectRequest(new Error('Timed out while opening the Browser workspace'));
    }, effectiveTimeout);
    const request = {
      conversationId,
      resolve: resolveRequest,
      reject: rejectRequest,
      timer,
      promise,
    };
    pending.set(requestId, request);
    pendingByConversation.set(conversationId, request);
    broadcast('browser:panel-reveal-request', {
      requestId,
      conversationId,
      focus: focus !== false,
      sessionPolicy: 'reuse-or-create',
    });
    return promise;
  }

  function acknowledge(payload = {}) {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const request = pending.get(requestId);
    if (!request) return false;
    if (payload.conversationId !== request.conversationId) return false;
    clearTimeout(request.timer);
    pending.delete(requestId);
    pendingByConversation.delete(request.conversationId);
    if (payload.ok === false) {
      request.reject(new Error(payload.error || 'Renderer could not open the Browser workspace'));
    } else {
      request.resolve({
        status: payload.status || 'opened',
        sessionId: payload.sessionId || null,
        focused: payload.focused !== false,
      });
    }
    return true;
  }

  function dispose() {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Browser workspace reveal service stopped'));
    }
    pending.clear();
    pendingByConversation.clear();
  }

  return Object.freeze({ ensureBrowserReady, acknowledge, dispose });
}
