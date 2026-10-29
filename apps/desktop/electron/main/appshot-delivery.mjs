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

const INPUT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function pickAppshotBot(bots) {
  const list = (Array.isArray(bots) ? bots : [])
    .filter((bot) => bot && typeof bot.workspaceId === 'string' && bot.workspaceId && bot.status !== 'archived');
  list.sort((left, right) => String(right.lastActiveAt || right.updatedAt || '').localeCompare(
    String(left.lastActiveAt || left.updatedAt || ''),
  ));
  return list[0] || null;
}

export function buildAppshotSubmission(payload, workspaceId, options = {}) {
  const raw = `appshot-${String(payload?.appshotId || '').trim()}`.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 128);
  const inputId = INPUT_ID.test(raw) ? raw : 'appshot';
  const ref = typeof payload?.visual?.artifactRef === 'string' ? payload.visual.artifactRef.trim() : '';
  const message = buildAppshotMessage(payload, options);
  return {
    workspaceId,
    inputId,
    surface: 'desktop',
    text: `Appshot — ${payload?.source?.appName || 'window'}`,
    attachmentRefs: ref ? [ref] : [],
    attachments: message.attachments,
  };
}

/** Hotkey result after delivery. A failed bot delivery must not look like success. */
export function completeAppshotHotkey(source, result, delivery, notify, log) {
  if (!delivery || delivery.ok === false) {
    const code = delivery?.code || 'NO_BOT';
    if (typeof notify === 'function') notify(source, { ok: false, code });
    return { ok: false, code, delivery };
  }
  if (typeof log === 'function') {
    const target = delivery.conversationId || delivery.workspaceId || '';
    log(`[appshot] delivered ${target}${delivery.created ? ' (new)' : ''}`.trim());
  }
  if (typeof notify === 'function') {
    notify(source, { ok: true, appName: result?.payload?.source?.appName, delivery });
  }
  return { ...result, delivery };
}

/**
 * Deliver a successful appshot.
 * Classic shell appends one user message and does not run the agent.
 * Bot shell submits the artifact ref to the most recently active bot.
 * @param {object} deps
 */
export function deliverAppshot({
  payload,
  listConversations,
  createConversation,
  appendMessage,
  options,
  shell,
  listBots,
  submitInput,
}) {
  if (shell === 'bots') {
    const bot = pickAppshotBot(typeof listBots === 'function' ? listBots() : []);
    if (!bot || typeof submitInput !== 'function') return { ok: false, code: 'NO_BOT' };
    const submission = buildAppshotSubmission(payload, bot.workspaceId, options);
    const saved = submitInput(submission);
    if (saved && saved.ok === false) return { ok: false, code: 'NO_BOT' };
    return {
      ok: true,
      workspaceId: bot.workspaceId,
      conversationId: null,
      created: false,
      messageId: null,
      inputId: saved?.inputId || submission.inputId,
      attachmentRefs: submission.attachmentRefs,
    };
  }
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
