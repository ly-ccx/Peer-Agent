import { interactiveFeedbackFromFollowup, normalizeResourceFeedback, restoreResourceFeedbackTransport } from '@peer-agent/protocol';
import { encode, problem } from './storage.mjs';

/** Read-only admission of the actual frozen material. No mutable state, file, Tool, grant or task port. */
export function createInteractiveFeedbackAdmission({ stateStore }) {
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
  return { validate, restore };
}
