import { mostRestrictiveHookDecision } from '@peer-agent/runtime-core';

import {
  RUNTIME_EVENT_PROTOCOL_VERSION,
  type RuntimeSdk,
  type RuntimeSdkEvent,
  type RuntimeSdkEventListener,
  type RuntimeSdkExecuteRequest,
  type RuntimeSdkExecutionContext,
  type RuntimeSdkHookRecord,
  type RuntimeSdkOptions,
  type RuntimeSdkProviderExecution,
} from './contracts.ts';

type RuntimeSdkEventInput = RuntimeSdkEvent extends infer Event
  ? Event extends RuntimeSdkEvent
    ? Omit<Event, 'protocolVersion' | 'sequence' | 'occurredAt'>
    : never
  : never;

function normalizeRecords(records: readonly RuntimeSdkHookRecord[] | null | undefined): readonly RuntimeSdkHookRecord[] {
  return Array.isArray(records) ? records : [];
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

  function publish(event: RuntimeSdkEventInput): void {
    const nextEvent = {
      ...event,
      protocolVersion: RUNTIME_EVENT_PROTOCOL_VERSION,
      sequence: ++sequence,
      occurredAt: now(),
    } as RuntimeSdkEvent;
    for (const listener of listeners) {
      listener(nextEvent);
    }
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

    publish({ type: 'tool.started', ...eventBase });

    const preRecords = normalizeRecords(
      options.host.hookRunner?.runPreToolUse
        ? await options.host.hookRunner.runPreToolUse(hookPayload)
        : [],
    );
    const preDecision = mostRestrictiveHookDecision(preRecords);
    publish({
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
      publish({ type: 'tool.completed', ...eventBase, decision: 'deny', result });
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
      publish({ type: 'permission.requested', ...eventBase, decision: 'ask' });
      const approval = options.host.approvalPort
        ? await options.host.approvalPort.requestApproval(approvalRequest, context)
        : { decision: 'ask' as const };
      publish({ type: 'permission.resolved', ...eventBase, decision: approval.decision });

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
        publish({ type: 'tool.completed', ...eventBase, decision: approval.decision, result });
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
    publish({
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
    publish({ type: 'tool.completed', ...eventBase, decision: preDecision, result });
    return resolvedExecution;
  }

  return { execute, subscribe };
}
