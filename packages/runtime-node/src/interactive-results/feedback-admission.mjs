import { interactiveFeedbackFromFollowup, normalizeResourceFeedback, restoreResourceFeedbackTransport } from '@peer-agent/protocol';
import { encode, problem } from './storage.mjs';

/** Read-only admission of the actual frozen material. No mutable state, file, Tool, grant or task port. */
export function createInteractiveFeedbackAdmission({ stateStore, conversationStore }) {
  function validate(raw, workspaceId) {
    const row = normalizeResourceFeedback(raw);
    if (!row || row.resource.kind !== 'interactive' || row.recipient.workspaceId !== workspaceId) throw problem('INVALID_INTERACTIVE_FEEDBACK');
    let actual;
    try { actual = interactiveFeedbackFromFollowup(stateStore.readFollowup(row.recipient, row.id)); }
    catch { throw problem('INTERACTIVE_FEEDBACK_UNAVAILABLE'); }
    if (!actual || encode(actual) !== encode(row)) throw problem('INTERACTIVE_FEEDBACK_MISMATCH');
    return true;
  }
  function restore(message, workspaceId) {
    const rows = restoreResourceFeedbackTransport(message?.resourceFeedback, message?.attachments);
    for (const row of rows) {
      if (row.recipient.workspaceId !== workspaceId) throw problem('INVALID_RESOURCE_FEEDBACK');
      if (row.resource.kind === 'interactive') validate(row, workspaceId);
    }
    return rows;
  }
  function acquireMessageRoots(owner, conversationIds) {
    if ((conversationIds !== undefined && !conversationIds.includes(owner.conversationId)) || !conversationStore?.acquireMessageRetentionGuard)
      throw problem('interactive_retention_unavailable');
    const guard = conversationStore.acquireMessageRetentionGuard(conversationIds ?? owner);
    try {
      const selections = [];
      for (const messages of guard.histories.values()) {
        for (const message of messages) {
          if (message.attachments != null && !Array.isArray(message.attachments))
            throw problem('INVALID_RESOURCE_FEEDBACK');
          for (const row of restore(message, owner.workspaceId)) {
            if (row.resource.kind === 'interactive' && encode(row.resource.reference.owner) === encode(owner))
              selections.push({ reference: row.resource.reference, followupId: row.version.followupId });
          }
        }
      }
      if (!guard.assertCurrent()) throw problem('interactive_retention_stale');
      return { revision: guard.revision, selections, conversationIds: [...guard.histories.keys()], delegatedSessions: guard.delegatedSessions, assertCurrent: guard.assertCurrent, release: guard.release };
    } catch (error) { guard.release(); throw error; }
  }
  return { validate, restore, acquireMessageRoots };
}
