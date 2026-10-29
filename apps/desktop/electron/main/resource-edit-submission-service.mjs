import { createHash } from 'node:crypto';
import { RESOURCE_FILE_REPLACE_PROVIDER } from '@peer-agent/protocol';
const fail = code => ({ ok: false, code });
const hash = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const shape = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(key => keys.includes(key));
/** Orchestrates explicit intent; only the governed Runtime/journal can execute or produce facts. */
export function createResourceEditSubmissionService({ edits, storage, journal, permissions, sources }) {
  function request(operation) { return { workspaceId: operation.target.recipient.workspaceId, requestId: operation.requestId, payloadHash: operation.payloadHash }; }
  function status(operation, binding) {
    const current = journal.query(operation.target.recipient.workspaceId, operation.requestId);
    return current.ok ? { ...current, permission: permissions.pending(current.operation, binding), permissionElsewhere: permissions.waitingElsewhere(current.operation, binding) } : current;
  }
  const protect = fn => async (...args) => { try { return await fn(...args); } catch { return fail('RESOURCE_EDIT_SOURCE_UNAVAILABLE'); } };
  return {
    submit: protect(async (sender, input) => {
      const saved = await edits.withSubmissionView(sender, input, ({ binding, draft, writer }) => {
        const result = storage.apply(draft.target.recipient.workspaceId, { type: 'reserve', requestId: input.requestId, draftId: draft.id,
          revision: draft.revision, writer, providerId: RESOURCE_FILE_REPLACE_PROVIDER, proposedVersion: hash(draft.text) });
        return result.ok ? { ok: true, operation: result.operation, binding, fresh: result.changed } : result;
      });
      if (!saved.ok) return saved;
      if (saved.fresh) { const started = journal.start(request(saved.operation), saved.binding); if (!started.ok) return started; }
      return status(saved.operation, saved.binding);
    }),
    continueSubmission: protect((sender, input) => edits.withOperationView(sender, input, (binding, operation) => {
      const started = journal.start(request(operation), binding); return started.ok ? status(operation, binding) : started;
    })),
    operationStatus: protect((sender, input) => edits.withOperationView(sender, input, (binding, operation) => status(operation, binding))),
    reconcileSubmission: protect((sender, input) => edits.withOperationView(sender, input, async (binding, operation) => {
      const result = await journal.reconcile(request(operation), binding);
      return result.ok && edits.isSubmissionCurrent(binding, operation) ? { ...result, permission: permissions.pending(result.operation, binding), permissionElsewhere: permissions.waitingElsewhere(result.operation, binding) } : result.ok ? fail('RESOURCE_EDIT_SOURCE_CHANGED') : result;
    })),
    cancelSubmission: protect((sender, input) => edits.withOperationView(sender, input, (binding, operation) => {
      const result = journal.cancel(request(operation), binding); return result.ok ? status(operation, binding) : result;
    })),
    decideSubmissionPermission: protect((sender, input) => {
      if (!shape(input, ['handle', 'requestId', 'challengeId', 'argsDigest', 'allow'])) return fail('RESOURCE_EDIT_INVALID_REQUEST');
      return edits.withOperationView(sender, { handle: input.handle, requestId: input.requestId }, (binding, operation) => permissions.decide(operation, binding, input));
    }),
    readExecution: protect((sender, input) => edits.withOperationView(sender, input, async (binding, operation) => {
      const source = await sources.resolveSubmissionTarget(binding.sender, binding.source, operation.target);
      if (!source?.ok || !source.validate() || !edits.isSubmissionCurrent(binding, operation)) return fail(source?.code ?? 'RESOURCE_EDIT_SCOPE_DENIED');
      return storage.executionResult(operation.target.recipient.workspaceId, operation.requestId);
    })),
    readSubmission: protect((sender, input) => edits.withOperationView(sender, input, (_binding, operation) => storage.operationText(operation.target.recipient.workspaceId, operation.requestId))),
  };
}
