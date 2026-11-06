/**
 * Session Service (ADR 121).
 * Classic JSONL and Bot SQLite expose the same listMeta / getWindow / append / subscribeRevision.
 * Storage differences stay in the adapters. This seam does not grant capabilities or write Evidence.
 */

function presentMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return meta;
  const { messages, ...rest } = meta;
  return rest;
}

function presentList(page) {
  if (Array.isArray(page)) return page.map(presentMeta);
  if (!page || typeof page !== 'object') return page;
  return { ...page, items: (page.items || []).map(presentMeta) };
}

function reasonFor(changeType) {
  if (changeType === 'messages-updated' || changeType === 'created') return 'append';
  if (changeType === 'deleted') return 'external';
  return 'sidecar';
}

function subscribeRevision(store, scope, onRevision) {
  const only = typeof scope?.conversationId === 'string' ? scope.conversationId : null;
  const pending = new Map();
  let timer = null;
  const flush = () => {
    timer = null;
    const batch = [...pending.values()];
    pending.clear();
    for (const event of batch) onRevision(event);
  };
  const unsubscribe = store.subscribeChanges((event) => {
    if (!event?.conversationId) return;
    if (only && event.conversationId !== only) return;
    const preview = typeof store.readSessionPreview === 'function'
      ? store.readSessionPreview(event.conversationId)
      : null;
    const contentRevision = Number.isFinite(Number(preview?.contentRevision))
      ? Number(preview.contentRevision)
      : 0;
    pending.set(event.conversationId, {
      conversationId: event.conversationId,
      contentRevision,
      reason: reasonFor(event.changeType),
      workspacePath: event.workspacePath ?? null,
      writerPid: event.writerPid,
      changeType: event.changeType,
      revision: event.revision,
    });
    if (timer) return;
    timer = setTimeout(flush, 0);
    timer.unref?.();
  }, scope?.interval != null ? { interval: scope.interval } : undefined);
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending.clear();
    unsubscribe();
  };
}

function appendResult(store, input) {
  const id = input?.conversationId ?? input?.id;
  const result = store.appendMessage(id, input?.message, { returnMessages: false });
  if (!result || typeof result !== 'object') return null;
  const meta = presentMeta(result);
  return { meta, preview: meta.preview ?? null };
}

export function createClassicJsonlAdapter(store) {
  return {
    kind: 'classic-jsonl',
    listMeta(query = {}) {
      return presentList(store.listConversations(query));
    },
    getWindow(query = {}) {
      const id = query.conversationId;
      if (!id || typeof store.readConversationWindow !== 'function') return null;
      const full = query.full === true;
      const page = store.readConversationWindow(id, {
        ...(query.limit != null ? { limit: query.limit } : {}),
        ...(query.before != null ? { before: query.before } : {}),
        ...(full ? { full: true } : {}),
      });
      if (!page) return null;
      return {
        meta: presentMeta(page.meta),
        window: page.window,
        cursor: page.cursor ?? null,
        hasMore: page.hasMore === true,
        ...(full ? { diagnostic: true } : {}),
      };
    },
    append(input) {
      return appendResult(store, input);
    },
    subscribeRevision(scope, onRevision) {
      return subscribeRevision(store, scope, onRevision);
    },
  };
}

/**
 * Bot body reads use the existing interaction SQLite read model.
 * Append still commits through the canonical transcript the store already owns;
 * this adapter does not invent a second message table or move classic JSONL.
 */
export function createBotSqliteAdapter(store) {
  return {
    kind: 'bot-sqlite',
    listMeta(query = {}) {
      return presentList(store.listConversations(query));
    },
    async getWindow(query = {}) {
      const id = query.conversationId;
      if (!id) return null;
      if (query.full === true) {
        const page = store.readConversationWindow?.(id, { full: true, limit: query.limit });
        if (!page) return null;
        return {
          meta: presentMeta(page.meta),
          window: page.window,
          cursor: null,
          hasMore: false,
          diagnostic: true,
        };
      }
      if (typeof store.readInteractionPage !== 'function') return null;
      const page = await store.readInteractionPage(id, {
        ...(query.limit != null ? { limit: query.limit } : {}),
        ...(query.before ? { before: query.before } : {}),
      });
      if (!page) return null;
      const meta = typeof store.readSessionMeta === 'function'
        ? store.readSessionMeta(id)
        : { id, contentRevision: page.contentRevision };
      return {
        meta: presentMeta(meta) ?? { id, contentRevision: page.contentRevision },
        window: page.messages || [],
        cursor: page.nextCursor ?? null,
        hasMore: Boolean(page.nextCursor),
        sourceVersion: page.sourceVersion,
      };
    },
    append(input) {
      return appendResult(store, input);
    },
    subscribeRevision(scope, onRevision) {
      return subscribeRevision(store, scope, onRevision);
    },
  };
}

export function createSessionService(adapter) {
  if (!adapter || typeof adapter.listMeta !== 'function' || typeof adapter.getWindow !== 'function'
    || typeof adapter.append !== 'function' || typeof adapter.subscribeRevision !== 'function') {
    throw new TypeError('Session adapter must implement listMeta, getWindow, append, subscribeRevision');
  }
  return Object.freeze({
    kind: adapter.kind,
    listMeta: (query) => Promise.resolve(adapter.listMeta(query)),
    getWindow: (query) => Promise.resolve(adapter.getWindow(query)),
    append: (input) => Promise.resolve(adapter.append(input)),
    subscribeRevision: (scope, onRevision) => adapter.subscribeRevision(scope, onRevision),
  });
}
