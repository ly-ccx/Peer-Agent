import { admitRemoteRead, parseRemoteReadRequest } from '@peer-agent/protocol';
import { createProjectionGuard } from './projection-guard.mjs';

/** Host-only adapter for ADR75 task.read. resolveLocal must derive task ownership,
 * delegation and execution context from local stores, never the remote body.
 * host is the existing local tool host; no direct Provider or store execution.
 * Receipt deduplication and durable result publication belong to the caller.
 */
export function createRemoteGoalReader({ resolveLocal, getSession, getProjection, host }) {
  const guard = createProjectionGuard({ getSession, getProjection });
  return async function read(value) {
    const parsed = parseRemoteReadRequest(value);
    if (!parsed.ok) return parsed;
    let local;
    let admission;
    try {
      local = await resolveLocal(parsed.request);
      admission = admitRemoteRead(parsed.request, local.admission);
    } catch {
      return { ok: false, code: 'LOCAL_STATE_UNAVAILABLE' };
    }
    if (!admission.ok) return admission;
    const request = admission.request;
    // Mapping is supplied by the authoritative local task lookup, not remote args.
    if (!local.planId || local.taskId !== request.taskId || !local.executionContext) {
      return { ok: false, code: 'TASK_DENIED' };
    }
    const session = getSession();
    const projection = getProjection();
    if (!session || !projection) return { ok: false, code: 'RUNTIME_UNAVAILABLE' };
    const event = {
      type: 'client_tool_call.request', sessionId: session.sessionId,
      projectionId: projection.projectionId,
      call: { toolCallId: `remote-${request.requestId}`, capabilityId: 'local.goal.get_plan',
        arguments: { planId: local.planId } },
    };
    const projected = guard.validateRequest(event);
    if (!projected.accepted) return { ok: false, code: 'CAPABILITY_DENIED' };
    const execution = await host.execute(event, local.executionContext);
    // Never replace absent execution evidence with an assistant-generated success.
    if (!execution?.result?.evidence || execution.result.toolCallId !== event.call.toolCallId
        || execution.result.evidence.toolCallId !== event.call.toolCallId
        || !execution.grant || execution.grant.toolCallId !== event.call.toolCallId) {
      return { ok: false, code: 'EXECUTION_EVIDENCE_MISSING' };
    }
    // Execution can await: authorization/ownership may have changed meanwhile.
    // Fail closed without exporting even Evidence payloads on the revoked route.
    try {
      const current = await resolveLocal(request);
      const exportAdmission = admitRemoteRead(request, current.admission);
      if (!exportAdmission.ok || current.planId !== local.planId || current.taskId !== local.taskId
          || !guard.validateRequest(event).accepted) {
        return { ok: false, code: 'RESULT_EXPORT_DENIED' };
      }
    } catch {
      return { ok: false, code: 'RESULT_EXPORT_DENIED' };
    }
    return { ok: true, execution };
  };
}
