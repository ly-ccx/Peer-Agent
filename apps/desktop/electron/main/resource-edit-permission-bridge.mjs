import { randomUUID } from 'node:crypto';
import { digestApprovalArgs, createOneTimeApprovalBook } from '@peer-agent/runtime-node';
import { RESOURCE_FILE_REPLACE_CAPABILITY, normalizeResourceEditHandle, resourceEditToken, resourceEditDigest } from '@peer-agent/protocol';
import { createChatPermissionGate } from './chat-runtime/permission-gate.mjs';
import { createPermissionGrant } from './runtime-gateway/tool-result-factory.mjs';
const fail = code => ({ ok: false, code });
const key = op => `resource-edit:${op.requestId}`;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
/** Adapter over the existing permission rules. Its Map holds resource operations, never model/chat executions. */
export function createResourceEditPermissionBridge({ authority, approvalStore, isCurrent, notify = () => {}, now = Date.now, createId = randomUUID, permissionTimers, permissionWaitMs } = {}) {
  if (!authority?.read || !approvalStore?.append || typeof isCurrent !== 'function') throw TypeError('Resource permissions require actual Bot authority, durable approvals and source binding.');
  const operations = new Map(), challenges = new Map(); let disposed = false;
  const valid = entry => !!entry && !disposed && isCurrent(entry.binding, entry.operation) === true;
  function changed(entry) { try { notify(entry.operation.target.recipient.workspaceId, { kind: 'operation', draftId: entry.operation.draftId, requestId: entry.operation.requestId }); } catch {} }
  const gate = createChatPermissionGate({ registerActive: false, activeStreams: operations, approvalStore, now, permissionTimers, permissionWaitMs,
    oneTimeApprovals: createOneTimeApprovalBook(),
    resolveAccessPolicy({ streamId }) {
      const entry = operations.get(streamId); if (!valid(entry)) return { ok: false, code: 'OUT_OF_SCOPE' };
      const actual = authority.read(entry.operation.target.recipient.workspaceId);
      return actual?.ok && actual.policy?.conversationId === entry.operation.target.recipient.conversationId ? actual : { ok: false, code: 'POLICY_UNAVAILABLE' };
    },
    resolveApprovalScope({ streamId }) { const op = operations.get(streamId)?.operation; return op ? { ...op.target.recipient, planId: null } : {}; },
    resolvePermissionPrincipal({ streamId }) { const entry = operations.get(streamId); return valid(entry) ? { ...entry.operation.target.recipient } : null; },
    settleNotifier(streamId, ids) {
      for (const id of ids) challenges.delete(id);
      const entry = operations.get(streamId); if (entry) changed(entry);
    },
  });
  function owner(entry, binding, operation) {
    return valid(entry) && isCurrent(binding, operation) === true && entry.binding.sender === binding.sender
      && entry.binding.handle.windowId === binding.handle.windowId && entry.operation.payloadHash === operation.payloadHash;
  }
  return {
    begin(operation, binding) {
      if (disposed || operations.size >= 64 || !isCurrent(binding, operation)) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
      const id = key(operation), old = operations.get(id);
      if (old) return fail('RESOURCE_EDIT_OPERATION_PENDING');
      operations.set(id, { operation, binding, permissionIds: new Set(), turnProfile: { role: 'resource_edit', ...operation.target.recipient,
        sessionId: operation.target.reference.task?.sessionId ?? operation.target.recipient.conversationId } });
      return { ok: true };
    },
    async request(operation, binding, request, { signal } = {}) {
      const id = key(operation), entry = operations.get(id);
      if (!owner(entry, binding, operation)) return { granted: false, reason: 'RESOURCE_EDIT_SOURCE_CHANGED' };
      const webContents = { isDestroyed: () => !valid(entry), send(topic, event) {
        if (topic !== 'chat:stream:permission-request' || !valid(entry) || event.streamId !== id || !event.call?.toolCallId || challenges.size >= 64) throw Error('RESOURCE_EDIT_PERMISSION_UNAVAILABLE');
        const call = event.call;
        const challenge = { requestId: operation.requestId, challengeId: createId(), argsDigest: `sha256:${digestApprovalArgs({ args: call.arguments, scope: call.argumentsPreview,
          confirmation: call.confirmation ?? null, payloadHash: operation.payloadHash })}`, deadlineAt: event.deadlineAt,
          path: operation.target.reference.path, expectedVersion: operation.target.base.contentVersion, proposedVersion: operation.proposedVersion,
          reason: typeof call.reason === 'string' ? call.reason.slice(0, 2048) : 'resource_edit_permission',
          ...(call.confirmation ? { confirmation: String(call.confirmation.reason ?? 'hook_approval_required').slice(0, 2048) } : {}) };
        if (!resourceEditToken(challenge.challengeId) || !resourceEditDigest(challenge.argsDigest) || !Number.isFinite(Date.parse(challenge.deadlineAt))) throw Error('RESOURCE_EDIT_PERMISSION_UNAVAILABLE');
        challenges.set(call.toolCallId, { entry, call, challenge }); changed(entry);
      } };
      return gate.createLocalCapabilityPermissionRequester({ webContents, streamId: id, toolCallId: id,
        conversationId: operation.target.recipient.conversationId, workspacePath: typeof request.workspacePath === 'string' ? request.workspacePath : null,
        signal, grantScope: RESOURCE_FILE_REPLACE_CAPABILITY, respectConfirmation: true })(request);
    },
    pending(operation, binding) {
      const entry = operations.get(key(operation)); if (!owner(entry, binding, operation)) return null;
      const found = [...challenges.values()].find(item => item.entry === entry);
      return found ? structuredClone(found.challenge) : null;
    },
    waitingElsewhere(operation, binding) {
      const entry = operations.get(key(operation)); return valid(entry) && isCurrent(binding, operation) === true && entry.binding.sender !== binding.sender
        && entry.operation.payloadHash === operation.payloadHash && [...challenges.values()].some(item => item.entry === entry);
    },
    decide(operation, binding, request) {
      if (!shape(request, ['handle', 'requestId', 'challengeId', 'argsDigest', 'allow']) || !normalizeResourceEditHandle(request.handle)
        || request.requestId !== operation.requestId || !resourceEditToken(request.challengeId) || !resourceEditDigest(request.argsDigest) || typeof request.allow !== 'boolean') return fail('RESOURCE_EDIT_INVALID_REQUEST');
      gate.refreshAccessPolicies();
      const entry = operations.get(key(operation)), found = [...challenges.values()].find(item => item.entry === entry && item.challenge.challengeId === request.challengeId);
      if (!owner(entry, binding, operation) || !found || !equal(request.handle, binding.handle) || found.challenge.argsDigest !== request.argsDigest
        || Number(now()) >= Date.parse(found.challenge.deadlineAt)) return fail('RESOURCE_EDIT_PERMISSION_EXPIRED');
      const grant = createPermissionGrant({ toolCallId: found.call.toolCallId, granted: request.allow, scope: RESOURCE_FILE_REPLACE_CAPABILITY });
      const accepted = gate.settlePermissionRequest(found.call.toolCallId, grant, { remember: false, decidedBy: 'local_ui' });
      return accepted ? { ok: true } : fail('RESOURCE_EDIT_PERMISSION_EXPIRED');
    },
    finish(operation) {
      const id = key(operation), entry = operations.get(id); if (!entry) return;
      gate.settleStreamPermissionRequests(id, { granted: false, duration: 'denied' });
      for (const [id, item] of challenges) if (item.entry === entry) challenges.delete(id);
      operations.delete(id); changed(entry);
    },
    dispose() { for (const entry of [...operations.values()]) { gate.settleStreamPermissionRequests(key(entry.operation), { granted: false, duration: 'denied' }); } disposed = true; operations.clear(); challenges.clear(); },
  };
}
