import { captureResourceEditExecution, captureResourceEditPostlude } from './resource-edit-execution-record.mjs';
import { createHash } from 'node:crypto';
import { resourceEditOperationPayload } from '@peer-agent/runtime-core';
import { createRuntimeSdk } from '@peer-agent/runtime-sdk';
import { createNodeRuntimeHostAdapter } from '@peer-agent/runtime-node';
import { normalizeResourceEditOperation, RESOURCE_FILE_REPLACE_CAPABILITY, RESOURCE_FILE_REPLACE_PROVIDER, RESOURCE_FILE_REPLACE_TOOL, validResourceEditText } from '@peer-agent/protocol';
import { createCapabilityProviderRegistry } from './runtime-gateway/capability-provider-registry.mjs';
import { createLocalConditionalFileProvider } from './runtime-gateway/local-conditional-file-provider.mjs';
import { createResourceFileReplaceProjection } from './runtime-gateway/resource-file-replace-projection.mjs';
import { createFailedClientToolResult, createPermissionGrant, nowIso } from './runtime-gateway/tool-result-factory.mjs';
import { appendHookEvidence } from './runtime-gateway/hook-evidence.mjs';
const digest = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
function frozen(value) { if (value && typeof value === 'object') { for (const field of Object.values(value)) frozen(field); Object.freeze(value); } return value; }
/** Actual Runtime chain for one already-started journal operation. No renderer, fs or journal fact creation port. */
export function createResourceEditRuntime({ resolveTarget, isIntentCurrent, requestPermission, sessionStore, hookRunner, onRuntimeEvent, recordExecution, recordPostlude, workspaceRoot } = {}) {
  for (const port of [resolveTarget, isIntentCurrent, requestPermission, recordExecution, recordPostlude]) if (typeof port !== 'function') throw TypeError('Resource edit runtime requires source, intent, permission and durable actual-result ports.');
  if (typeof sessionStore?.getSession !== 'function') throw TypeError('Resource edit runtime requires its existing session provider.');
  return {
    async execute({ operation: raw, content }, { signal } = {}) {
      const normalized = normalizeResourceEditOperation(raw);
      if (!normalized || normalized.phase !== 'running' || normalized.providerId !== RESOURCE_FILE_REPLACE_PROVIDER || digest(resourceEditOperationPayload(normalized)) !== normalized.payloadHash || !validResourceEditText(content) || digest(content) !== normalized.proposedVersion) throw Error('RESOURCE_EDIT_INVALID_DISPATCH');
      const operation = frozen(normalized), input = frozen({ requestId: operation.requestId, target: operation.target, proposedVersion: operation.proposedVersion, content });
      const session = sessionStore.getSession(), { projection } = createResourceFileReplaceProjection({ requestId: operation.requestId,
        conversationId: operation.target.recipient.conversationId, sessionId: operation.target.reference.task?.sessionId,
        accessLevel: session.accessLevel ?? 'ask_before_local' });
      frozen(projection);
      const call = frozen({ toolCallId: `resource-edit:${operation.requestId}`, capabilityId: RESOURCE_FILE_REPLACE_CAPABILITY, toolName: RESOURCE_FILE_REPLACE_TOOL,
        arguments: input, argumentsPreview: { requestId: operation.requestId, path: operation.target.reference.path,
          expectedVersion: operation.target.base.contentVersion, proposedVersion: operation.proposedVersion, bytes: Buffer.byteLength(content) },
        reason: 'User explicitly submitted this saved file draft.', riskLevel: 'L2_local_write', dataLevel: 'D2_sensitive', occurredAt: nowIso() });
      const provider = createLocalConditionalFileProvider({ resolveTarget: target => resolveTarget(operation, target),
        isIntentCurrent: (candidate, actualCall) => actualCall.toolCallId === call.toolCallId && candidate.requestId === input.requestId && candidate.content === input.content && candidate.proposedVersion === input.proposedVersion && JSON.stringify(candidate.target) === JSON.stringify(input.target) && isIntentCurrent(operation) === true });
      const providerRegistry = createCapabilityProviderRegistry({ providers: [provider] });
      let durable = null;
      async function persist(execution) {
        const record = captureResourceEditExecution(operation, { ...execution, call }, projection);
        const saved = await recordExecution(operation, record);
        if (!saved?.ok) throw Object.assign(Error('RESOURCE_EDIT_EXECUTION_UNCONFIRMED'), { code: saved?.code ?? 'RESOURCE_EDIT_EXECUTION_UNCONFIRMED' });
        durable = record; return record;
      }
      const providerExecutor = { execute: async (request, context) => {
        const execution = await providerRegistry.execute(request, context);
        if (execution) await persist(execution); // Commit the actual result before PostToolUse or other projections can fail.
        return execution;
      } };
      const permission = request => requestPermission(operation, { ...request, toolCallId: call.toolCallId, capabilityId: call.capabilityId,
        args: { requestId: operation.requestId, target: operation.target, proposedVersion: operation.proposedVersion, bytes: Buffer.byteLength(content) },
        scope: { kind: 'resource-edit', requestId: operation.requestId, path: operation.target.reference.path, expectedVersion: operation.target.base.contentVersion, proposedVersion: operation.proposedVersion },
      }, { signal });
      const runtime = createRuntimeSdk({ workspaceRoot, host: createNodeRuntimeHostAdapter({ providerExecutor, sessionProvider: sessionStore, workspaceRoot,
        hookRunner, appendHookEvidence, resultFactory: { createFailedResult: input => createFailedClientToolResult({ ...input, status: 'denied' }), createPermissionGrant },
        executionGate: () => isIntentCurrent(operation) === true ? null : 'RESOURCE_EDIT_SOURCE_CHANGED' }) });
      const unsubscribe = typeof onRuntimeEvent === 'function' ? runtime.subscribe(onRuntimeEvent) : () => {};
      try {
        const execution = await runtime.execute({ call, conversationId: operation.target.recipient.conversationId, sessionId: projection.sessionId, projectionId: projection.projectionId },
          { requestPermission: permission, resourceEditProjection: projection, signal, workspaceRoot });
        if (!durable) await persist(execution); // Genuine Hook/host denials did not enter the Provider.
        let governanceConfirmed = false;
        try { governanceConfirmed = !!(await recordPostlude(operation, captureResourceEditPostlude(operation, execution)))?.ok; } catch {}
        return { ...execution, call, projectionId: projection.projectionId, journalRecord: durable, governanceConfirmed };
      } catch (error) {
        if (!durable) throw error;
        try { await recordPostlude(operation, captureResourceEditPostlude(operation, null, { reason: 'RESOURCE_EDIT_POSTLUDE_UNCONFIRMED' })); } catch {}
        // The original actual effect remains accountable even if a later Hook throws.
        return { call, grant: durable.grant, result: { toolCallId: durable.result.toolCallId, status: durable.result.status, completedAt: durable.result.completedAt,
          outputPreview: durable.result.observation ?? { reason: durable.result.blockedReason, status: durable.result.status }, evidence: durable.result.evidence },
          projectionId: projection.projectionId, journalRecord: durable, governanceConfirmed: false };
      } finally { unsubscribe(); }
    },
  };
}
