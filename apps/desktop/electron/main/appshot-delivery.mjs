/**
 * Appshot destination routing (T6, P0a).
 *
 * Product contract (appshots-window-context-capture.md §6.2, P0a scope):
 * - destination = automatic only: most recently active, non-archived conversation;
 *   if none exists, create a new conversation.
 * - The appshot lands as a USER-side attachment message (thumbnail + metadata).
 * - Never auto-runs the agent (no model invocation from delivery).
 *
 * ADR 59 decision 3: the full PNG stays on disk as an artifact; the message
 * attachment carries artifactRef + a small thumbnail dataUrl only.
 */

/**
 * Pick the delivery target conversation.
 * @param {object} deps
 * @param {() => Array<{id:string, archivedAt?:string|null, updatedAt?:string|number}>} deps.listConversations
 * @param {(input?: object) => {id:string}} deps.createConversation
 * @returns {{ conversationId: string, created: boolean }}
 */
export function resolveAppshotDestination({ listConversations, createConversation }) {
  const all = listConversations() ?? [];
  const candidates = all
    .filter((c) => c && !c.archivedAt)
    .sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
  if (candidates.length > 0) {
    return { conversationId: candidates[0].id, created: false };
  }
  const created = createConversation({ title: 'Appshot' });
  return { conversationId: created.id, created: true };
}

function toTime(value) {
  if (typeof value === 'number') return value;
  const t = Date.parse(value ?? '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * Build the user-side message carrying the appshot attachment.
 * @param {import('@peer-agent/protocol').AppshotPayload} payload
 * @param {{ thumbnailDataUrl?: string }} [options]
 */
export function buildAppshotMessage(payload, options = {}) {
  const { source, visual } = payload;
  return {
    id: `appshot-${payload.appshotId}`,
    role: 'user',
    content: '',
    attachments: [{
      id: `att-${payload.appshotId}`,
      name: `Appshot — ${source.appName}`,
      mimeType: visual.mimeType,
      size: visual.byteSize,
      kind: 'image',
      // ADR 59: full image via artifactRef; only a small thumbnail may inline.
      artifactRef: visual.artifactRef,
      filePath: visual.filePath,
      dataUrl: options.thumbnailDataUrl,
      appshot: {
        appshotId: payload.appshotId,
        capturedAt: payload.capturedAt,
        appName: source.appName,
        bundleId: source.bundleId,
        width: visual.width,
        height: visual.height,
        textMode: payload.text?.mode ?? 'none',
      },
    }],
    createdAt: payload.capturedAt,
  };
}

/**
 * Deliver a successful appshot into a conversation. Does NOT run the agent.
 * @param {object} deps
 * @param {import('@peer-agent/protocol').AppshotPayload} deps.payload
 * @param {() => Array<object>} deps.listConversations
 * @param {(input?: object) => {id:string}} deps.createConversation
 * @param {(id: string, message: object) => unknown} deps.appendMessage
 * @param {{ thumbnailDataUrl?: string }} [deps.options]
 * @returns {{ ok: true, conversationId: string, created: boolean, messageId: string }}
 */
export function deliverAppshot({ payload, listConversations, createConversation, appendMessage, options }) {
  const destination = resolveAppshotDestination({ listConversations, createConversation });
  const message = buildAppshotMessage(payload, options);
  appendMessage(destination.conversationId, message);
  return {
    ok: true,
    conversationId: destination.conversationId,
    created: destination.created,
    messageId: message.id,
  };
}
