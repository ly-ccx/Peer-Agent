function fail(code) { throw Object.assign(new Error(code), { code }); }

/** Host application boundary. The caller identity must come from the governed
 * invocation/session, not tool arguments. authorize must check the live grant
 * and workspace policy on every call. This module does not register tools or
 * create grants; its ports must be wired by the capability/IPC composition root.
 */
export function createSelectionSideChatService({ store, authorize, resolveRuntimeState, now = () => new Date().toISOString() }) {
  for (const port of [authorize, resolveRuntimeState, now]) {
    if (typeof port !== 'function') throw new TypeError('Selection service requires host ports');
  }
  async function check(caller, targetId, operation) {
    if (!caller || typeof caller.conversationId !== 'string' || !caller.conversationId) fail('SESSION_CALLER_REQUIRED');
    if (await authorize({ caller, targetId, operation }) !== true) fail('SESSION_ACCESS_DENIED');
  }
  async function quote(caller, request) {
    const conversationId = caller?.conversationId;
    await check(caller, conversationId, 'quote');
    const runtimeState = await resolveRuntimeState(conversationId);
    await check(caller, conversationId, 'quote');
    return store.resolveSelectionReference({ conversationId, selection: request?.selection, runtimeState });
  }
  async function create(caller, request) {
    const parentConversationId = caller?.conversationId;
    await check(caller, parentConversationId, 'create-child');
    // Never forward renderer runtimeState, capturedAt, or parent identity.
    const runtimeState = await resolveRuntimeState(parentConversationId);
    await check(caller, parentConversationId, 'create-child');
    return store.createSelectionChild({ parentConversationId, requestId: request?.requestId,
      selection: request?.selection, confirmMissing: request?.confirmMissing === true,
      runtimeState, capturedAt: now() });
  }
  async function list(caller, { offset = 0, limit = 20, includeArchived = false } = {}) {
    await check(caller, caller?.conversationId, 'list-children');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('SESSION_PAGE_INVALID');
    const rows = store.listSelectionChildren(caller.conversationId);
    const visible = [];
    for (const row of rows) {
      if (!includeArchived && row.status === 'archived') continue;
      if (await authorize({ caller, targetId: row.id, operation: 'list-child' }) !== true) continue;
      let runtime = null;
      try { runtime = await resolveRuntimeState(row.id); } catch { /* Unknown is not idle. */ }
      // Runtime resolution can yield; recheck access and existence afterward.
      if (await authorize({ caller, targetId: row.id, operation: 'list-child' }) !== true) continue;
      const current = store.listSelectionChildren(caller.conversationId).find((item) => item.id === row.id);
      if (!current || (!includeArchived && current.status === 'archived')) continue;
      const runState = runtime?.conversationId === row.id
        && runtime.contentRevision === current.contentRevision
        && ['idle', 'running', 'error'].includes(runtime.status) ? runtime.status : 'unknown';
      const lifecycle = current.status === 'archived' ? 'archived'
        : current.messageCount === 0 ? 'draft' : 'active';
      // Explicit projection: no drafts, snapshots, request IDs or arbitrary metadata.
      visible.push({ id: current.id, title: current.title, status: current.status,
        sourceReference: current.sourceReference, contentRevision: current.contentRevision,
        lifecycle, runState, createdAt: current.createdAt,
        updatedAt: current.updatedAt, hasDraft: current.hasDraft });
    }
    await check(caller, caller.conversationId, 'list-children');
    return { items: visible.slice(offset, offset + limit), total: visible.length,
      nextOffset: offset + limit < visible.length ? offset + limit : null };
  }
  async function read(caller, { childId, limit = 20, maxCharacters = 16000 } = {}) {
    await check(caller, childId, 'read-child');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('SESSION_PAGE_INVALID');
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 64000) fail('SESSION_BUDGET_INVALID');
    const child = store.getConversation(childId);
    if (!child) fail('SESSION_CHILD_MISSING');
    if (child.selectionOrigin?.parentConversationId !== caller.conversationId) fail('SESSION_NOT_DIRECT_CHILD');
    const runtime = await resolveRuntimeState(childId);
    await check(caller, childId, 'read-child');
    const latest = store.getConversation(childId);
    if (!latest) fail('SESSION_CHILD_MISSING');
    if (latest.selectionOrigin?.parentConversationId !== caller.conversationId) fail('SESSION_NOT_DIRECT_CHILD');
    const history = store.getPersistedConversationHistory(childId);
    if (!runtime || runtime.conversationId !== childId || runtime.contentRevision !== history.contentRevision
      || !['idle', 'running'].includes(runtime.status)) fail('SESSION_RUNTIME_UNCONFIRMED');
    let rows = history.messages;
    if (runtime.status === 'running') {
      if (typeof runtime.activeMessageId !== 'string' || !runtime.activeMessageId) fail('SESSION_RUNTIME_UNCONFIRMED');
      const index = rows.findIndex((row) => row.id === runtime.activeMessageId);
      if (index >= 0) rows = rows.slice(0, index);
      else if (history.excludedFromMessageId !== runtime.activeMessageId) fail('SESSION_RUNTIME_UNCONFIRMED');
    }
    const messages = rows.filter((row) => ['user', 'assistant'].includes(row.role) && typeof row.content === 'string');
    const selected = [];
    let remaining = maxCharacters;
    let budgetTruncated = false;
    for (const row of messages.slice(-limit).reverse()) {
      if (remaining === 0) { budgetTruncated = true; break; }
      const characters = [...row.content];
      const contentTruncated = characters.length > remaining;
      const content = characters.slice(0, remaining).join('');
      remaining -= Math.min(characters.length, remaining);
      selected.unshift({ id: row.id, role: row.role, content,
        ...(contentTruncated ? { contentTruncated: true } : {}) });
      budgetTruncated ||= contentTruncated;
    }
    return { childId, contentRevision: history.contentRevision, runState: runtime.status,
      messages: selected, characterCount: maxCharacters - remaining,
      truncated: messages.length > limit || budgetTruncated, readAt: now() };
  }
  async function saveDraft(caller, request) {
    const sessionId = caller?.conversationId;
    await check(caller, sessionId, 'save-own-child-draft');
    // A parent's discovery grant does not grant mutation of a child's input.
    if (request?.childId !== undefined && request.childId !== sessionId) fail('SESSION_DRAFT_NOT_OWNED');
    const session = store.getConversation(sessionId);
    if (!session?.selectionOrigin) fail('SESSION_CHILD_MISSING');
    return store.updateSelectionChildDraft(sessionId, {
      text: request?.text, referenceIds: request?.referenceIds,
    });
  }
  return Object.freeze({ quote, create, list, read, saveDraft });
}
