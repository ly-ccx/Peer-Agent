import { mostRestrictiveHookDecision } from '@peer-agent/runtime-core';

import {
  RUNTIME_EVENT_PROTOCOL_VERSION,
  type RuntimeSdk,
  type RuntimeSdkEvent,
  type RuntimeSdkEventInput,
  type RuntimeSdkEventListener,
  type RuntimeSdkExecuteRequest,
  type RuntimeSdkExecutionContext,
  type RuntimeSdkHookRecord,
  type RuntimeSdkOptions,
  type RuntimeSdkProviderExecution,
} from './contracts.ts';

function normalizeRecords(records: readonly RuntimeSdkHookRecord[] | null | undefined): readonly RuntimeSdkHookRecord[] {
  return Array.isArray(records) ? records : [];
}

function createRuntimeEventId(sequence: number): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId ? `runtime-event-${randomId}` : `runtime-event-${Date.now()}-${sequence}`;
}

export function createRuntimeSdk(options: RuntimeSdkOptions): RuntimeSdk {
  if (!options?.host || typeof options.host.executeProvider !== 'function') {
    throw new TypeError('Runtime SDK requires a host.executeProvider adapter.');
  }
  if (typeof options.host.createBlockedExecution !== 'function') {
    throw new TypeError('Runtime SDK requires a host.createBlockedExecution adapter.');
  }

  const listeners = new Set<RuntimeSdkEventListener>();
  const now = options.now ?? (() => new Date().toISOString());
  let sequence = 0;

  function emit(event: RuntimeSdkEventInput): RuntimeSdkEvent {
    const nextSequence = ++sequence;
    const nextEvent = {
      ...event,
      protocolVersion: RUNTIME_EVENT_PROTOCOL_VERSION,
      eventId: createRuntimeEventId(nextSequence),
      sequence: nextSequence,
      occurredAt: now(),
    } as RuntimeSdkEvent;
    for (const listener of listeners) {
      try {
        listener(nextEvent);
      } catch {
        // Runtime events are observational. A broken subscriber must not interrupt execution.
      }
    }
    return nextEvent;
  }

  function subscribe(listener: RuntimeSdkEventListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function execute(
    request: RuntimeSdkExecuteRequest,
    context: RuntimeSdkExecutionContext = {},
  ): Promise<RuntimeSdkProviderExecution> {
    const call = request?.call;
    if (!call?.toolCallId || !call?.capabilityId) {
      throw new TypeError('Runtime SDK execute requires call.toolCallId and call.capabilityId.');
    }

    const eventBase = {
      toolCallId: call.toolCallId,
      capabilityId: call.capabilityId,
      sessionId: request.sessionId,
      projectionId: request.projectionId,
      conversationId: request.conversationId,
    };
    const hookPayload = {
      sessionId: request.sessionId,
      projectionId: request.projectionId,
      conversationId: request.conversationId,
      call,
    };

    emit({ type: 'tool.started', ...eventBase });

    const preRecords = normalizeRecords(
      options.host.hookRunner?.runPreToolUse
        ? await options.host.hookRunner.runPreToolUse(hookPayload)
        : [],
    );
    const preDecision = mostRestrictiveHookDecision(preRecords);
    emit({
      type: 'hook.completed',
      ...eventBase,
      phase: 'PreToolUse',
      decision: preDecision,
      records: preRecords,
    });

    if (preDecision === 'deny') {
      const blocked = options.host.createBlockedExecution({
        request,
        context,
        decision: 'deny',
        reason: preRecords.find((record) => record.decision === 'deny')?.reason ?? 'hook_denied',
      });
      const result = options.host.appendHookEvidence
        ? options.host.appendHookEvidence(blocked.result, preRecords, preDecision)
        : blocked.result;
      const resolvedBlocked = { ...blocked, result };
      emit({ type: 'tool.completed', ...eventBase, decision: 'deny', result });
      return resolvedBlocked;
    }

    if (preDecision === 'ask') {
      const approvalRequest = {
        kind: 'hook' as const,
        hookEvent: 'PreToolUse' as const,
        call,
        toolCallId: call.toolCallId,
        capabilityId: call.capabilityId,
        args: call.arguments ?? call.argumentsPreview ?? {},
        workspacePath: context.workspaceRoot ?? options.workspaceRoot,
        reason: preRecords.find((record) => record.decision === 'ask')?.reason ?? 'hook_approval_required',
      };
      emit({ type: 'permission.requested', ...eventBase, decision: 'ask' });
      const approval = options.host.approvalPort
        ? await options.host.approvalPort.requestApproval(approvalRequest, context)
        : { decision: 'ask' as const };
      emit({ type: 'permission.resolved', ...eventBase, decision: approval.decision });

      if (approval.decision !== 'allow') {
        const blocked = options.host.createBlockedExecution({
          request,
          context,
          decision: approval.decision,
          reason: approval.decision === 'deny' ? 'hook_approval_denied' : 'hook_approval_required',
          approval,
        });
        const result = options.host.appendHookEvidence
          ? options.host.appendHookEvidence(blocked.result, preRecords, preDecision)
          : blocked.result;
        const resolvedBlocked = { ...blocked, result };
        emit({ type: 'tool.completed', ...eventBase, decision: approval.decision, result });
        return resolvedBlocked;
      }
    }

    const execution = await options.host.executeProvider(request, context);
    const postRecords = normalizeRecords(
      options.host.hookRunner?.runPostToolUse
        ? await options.host.hookRunner.runPostToolUse({
            ...hookPayload,
            result: execution.result,
          })
        : [],
    );
    emit({
      type: 'hook.completed',
      ...eventBase,
      phase: 'PostToolUse',
      decision: mostRestrictiveHookDecision(postRecords),
      records: postRecords,
    });

    const result = options.host.appendHookEvidence
      ? options.host.appendHookEvidence(
          execution.result,
          [...preRecords, ...postRecords],
          preDecision,
        )
      : execution.result;
    const resolvedExecution = { ...execution, result };
    emit({ type: 'tool.completed', ...eventBase, decision: preDecision, result });
    return resolvedExecution;
  }

  return { emit, execute, subscribe };
}
