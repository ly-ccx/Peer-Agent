import { randomUUID } from 'node:crypto';

export const RUNTIME_GATEWAY_PROTOCOL_VERSION = 1;

export function createEventId(prefix = 'evt') {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function isRuntimeGatewayDisabled(env = process.env) {
  const raw = String(env.ZEUS_ATLAS_RUNTIME_GATEWAY_DISABLED ?? '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function runtimeGatewayPath(env = process.env) {
  return env.ZEUS_ATLAS_RUNTIME_GATEWAY_WS_PATH || '/api/client/runtime/ws';
}

export function toWebSocketUrl(baseUrl, pathname, query = {}) {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, `${baseUrl}/`);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

export function parseGatewayMessage(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
  if (parsed?.type) return parsed;
  if (parsed?.method === 'client_tool_call.request') {
    return {
      type: 'client_tool_call.request',
      ...parsed.params,
      eventId: parsed.params?.eventId ?? parsed.id ?? createEventId('call'),
    };
  }
  if (parsed?.event?.type) return parsed.event;
  throw new Error('Unsupported runtime gateway message.');
}

export function createHelloEvent({ session, projection, clientVersion, platform }) {
  return {
    type: 'client.hello',
    eventId: createEventId('hello'),
    sessionId: session.sessionId,
    session,
    projection,
    client: {
      name: 'zeus-atlas-desktop',
      version: clientVersion,
      platform,
      locale: session.locale,
    },
    protocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION,
    sentAt: nowIso(),
  };
}

export function createResumeEvent({ sessionId, projectionId, lastAckSeq, pendingResultCount }) {
  return {
    type: 'runtime.resume',
    eventId: createEventId('resume'),
    sessionId,
    ...(projectionId ? { projectionId } : {}),
    ...(lastAckSeq !== undefined ? { lastAckSeq } : {}),
    pendingResultCount,
    protocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION,
    sentAt: nowIso(),
  };
}

export function createHeartbeatEvent({ sessionId, projectionId }) {
  return {
    type: 'runtime.heartbeat',
    eventId: createEventId('heartbeat'),
    sessionId,
    ...(projectionId ? { projectionId } : {}),
    sentAt: nowIso(),
  };
}

export function createProjectionPublishedEvent({ sessionId, projectionId, accepted, expiresAt }) {
  return {
    type: 'runtime.projection_published',
    eventId: createEventId('projection'),
    sessionId,
    projectionId,
    accepted,
    ...(expiresAt ? { expiresAt } : {}),
    publishedAt: nowIso(),
  };
}

export function createAckEvent({ request, status, reason }) {
  return {
    type: 'client_tool_call.ack',
    eventId: createEventId('ack'),
    sessionId: request.sessionId,
    projectionId: request.projectionId,
    toolCallId: request.call?.toolCallId,
    seq: request.seq,
    status,
    ...(reason ? { reason } : {}),
    ackedAt: nowIso(),
  };
}

export function createResultEvent({ request, report }) {
  return {
    type: 'client_tool_call.result',
    eventId: createEventId('result'),
    sessionId: request.sessionId,
    projectionId: request.projectionId,
    seq: request.seq,
    report,
    reportedAt: nowIso(),
  };
}

export function createErrorEvent({ sessionId, code, message, retryable }) {
  return {
    type: 'runtime.error',
    eventId: createEventId('error'),
    sessionId,
    code,
    message,
    retryable,
    occurredAt: nowIso(),
  };
}
