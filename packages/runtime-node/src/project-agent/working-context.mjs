import { createHash } from 'node:crypto';
import { workBudgetBinding } from './work-budget.mjs';
import { memorySecretReason } from '../memory/memory-redaction.mjs';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const idFor = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Working state stays in the existing device journal; no project files or long-term memory writes. */
export function createWorkingContext({ supervisor, now = () => new Date().toISOString() }) {
  function scope(input, view, mutation = false) {
    if (!['project_agent', 'work_session'].includes(view.role) || view.role === 'work_session' && view.agentKind !== 'worker') fail('working_context_role_denied');
    const journal = workBudgetBinding(view.workspaceId)?.store;
    const workId = input.workId || view.workId;
    const work = journal?.readWork(workId);
    if (!work || !view.conversationId) fail('working_context_unavailable');
    if (view.role === 'project_agent') {
      if (work.parentConversationId !== view.conversationId) fail('working_context_out_of_scope');
    } else {
      const session = supervisor?.get?.({ sessionId: view.sessionId });
      if (workId !== view.workId || session?.conversationId !== view.conversationId || session?.origin?.workId !== workId) fail('working_context_out_of_scope');
    }
    if (mutation && view.role === 'work_session') {
      const current = journal.readLifecycleFacts().mandates?.[workId]?.executionBindings?.[view.sessionId];
      if (!current || !view.coordinationBinding || current.goalRevision !== view.coordinationBinding.goalRevision
        || current.executionEpoch !== view.coordinationBinding.executionEpoch) fail('agent_execution_stale');
    }
    if (mutation && (workId !== view.workId || ['paused', 'cancelled', 'coalesced', 'delivered'].includes(work.state))) fail('work_execution_stopped');
    return { journal, work, workId, conversationId: view.conversationId };
  }
  async function execute(name, input, view, operationId) {
    const mutation = ['write_work_note', 'prepare_context_handoff'].includes(name);
    const { journal, work, workId, conversationId } = scope(input, view, mutation);
    if (name === 'read_work_notes') {
      const rows = input.noteId ? [journal.readSupervision('workNotes', input.noteId)].filter(Boolean)
        : journal.querySupervision('workNotes', 'workId', workId, { limit: input.limit || 20, ...(view.role === 'project_agent' ? {} : { conversationId }) });
      return { ok: true, notes: rows.filter(note => note.workId === workId && (view.role === 'project_agent' || note.conversationId === conversationId)) };
    }
    if (name === 'write_work_note') {
      if (!/^[\p{L}\p{N}_ .-]{1,120}$/u.test(input.name || '') || !input.text?.trim() || input.text.length > 12000
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('work_note_invalid');
      if (memorySecretReason(input.text)) fail('working_context_sensitive');
      const noteId = `note-${idFor([workId, conversationId, input.name])}`;
      const previous = journal.readSupervision('workNotes', noteId);
      const payloadHash = idFor([input.name, input.text, input.sourceRefs || [], input.expectedRevision]);
      if (previous?.operationId === operationId) {
        if (previous.payloadHash !== payloadHash) fail('work_note_operation_conflict');
        return { ok: true, note: previous, replayed: true };
      }
      const note = { noteId, name: input.name, text: input.text, workId, conversationId, operationId, payloadHash,
        sourceRefs: input.sourceRefs || [], at: now() };
      journal.enableSupervision();
      journal.append({ kind: 'work_note_written', operationId, note, expectedRevision: input.expectedRevision }, { returnState: false });
      return { ok: true, note: journal.readSupervision('workNotes', noteId) };
    }
    if (name === 'search_work_history') {
      const page = await supervisor?.readWorkHistory?.({ ...input, workId }, view);
      if (!page || page.error) fail(page?.error || 'history_unavailable');
      const query = (input.query || '').toLocaleLowerCase();
      const matches = (page.messages || []).map(message => ({ messageId: message.id, conversationId: page.conversationId,
        kind: message.kind, text: typeof message.content === 'string' ? message.content : JSON.stringify(message.publicUpdates || []) }))
        .filter(message => !query || message.text.toLocaleLowerCase().includes(query)).slice(0, input.limit || 20)
        .map(message => ({ ...message, text: memorySecretReason(message.text) ? '[sensitive history content omitted]' : message.text.slice(0, 2000), sourceVersion: page.sourceVersion }));
      return { ok: true, matches, nextCursor: page.nextCursor, searchedOnePage: true, sourceVersion: page.sourceVersion };
    }
    if (name === 'prepare_context_handoff') {
      if (!input.hint?.trim() || input.hint.length > 6000 || memorySecretReason(input.hint)) fail('context_hint_invalid');
      const previous = input.previousWindowId && journal.readSupervision('contextWindows', input.previousWindowId);
      if (input.previousWindowId && (!previous || previous.workId !== workId || previous.conversationId !== conversationId)) fail('context_window_out_of_scope');
      const requests = journal.querySupervision('agentRequests', view.role === 'project_agent' ? 'parentConversationId' : 'sessionId', view.role === 'project_agent' ? conversationId : view.sessionId, { pendingOnly: true, limit: 32 });
      const windowId = `window-${idFor([workId, conversationId, operationId])}`;
      const existing = journal.readSupervision('contextWindows', windowId);
      const payloadHash = idFor([input.hint, input.previousWindowId || null, input.historyCursor || null]);
      if (existing) {
        if (existing.payloadHash !== payloadHash) fail('context_window_operation_conflict');
        return { ok: true, window: existing, replayed: true };
      }
      const observedSessions = new Set([...(work.sessionIds || []), ...(work.pendingEventIds || []).map(id => journal.readSnapshot().events[id]?.event.sessionId).filter(Boolean)]);
      const window = { windowId, workId, conversationId, hint: input.hint, budgetRef: work.workId,
        state: 'prepared', payloadHash, previousWindowId: input.previousWindowId, historyCursor: input.historyCursor,
        obligationRefs: [`work:${workId}`, ...requests.filter(row => row.workId === workId || observedSessions.has(row.sessionId)).map(row => row.requestId)], at: now() };
      journal.enableSupervision(); journal.append({ kind: 'context_window_opened', operationId, window }, { returnState: false });
      return { ok: true, window, providerWindowChanged: false };
    }
    fail('working_context_tool_unknown');
  }
  return { execute };
}

/** Host projection is an admitted factual work set, not model-authored system instructions. */
export function readWorkingContext({ workspaceId, workId, conversationId } = {}) {
  const journal = workBudgetBinding(workspaceId)?.store;
  if (!journal || !workId || !conversationId) return undefined;
  const work = journal.readWork(workId);
  if (!work) return undefined;
  let remaining = 6000;
  const notes = journal.querySupervision('workNotes', 'workId', workId, { conversationId, limit: 8 })
    .flatMap(note => { const text = note.text.slice(0, Math.min(2000, remaining)); remaining -= text.length; return text ? [{ ...note, text }] : []; });
  const window = journal.querySupervision('contextWindows', 'workId', workId, { conversationId, limit: 1 })[0];
  return { workId, notes, ...(window ? { windowId: window.windowId, hint: window.hint, historyCursor: window.historyCursor } : {}),
    obligationRefs: [...new Set([`work:${workId}`, ...(window?.obligationRefs || [])])], budgetRef: workId };
}
