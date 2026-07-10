import type {
  RuntimeSdkApprovalDecision,
  RuntimeSdkHostAdapter,
  RuntimeSdkToolResult,
} from '@peer-agent/runtime-sdk';

import type {
  CreateNodeRuntimeHostAdapterOptions,
  NodeRuntimeExecutionContext,
  NodeRuntimePermissionResponse,
} from './contracts.ts';

function resolveLocale(session: { readonly locale?: string }): string | undefined {
  return typeof session.locale === 'string' ? session.locale : undefined;
}

function defaultDataLevel(call: Record<string, unknown>): unknown {
  return call.dataLevel ?? 'D0_public';
}

export function createNodeRuntimeHostAdapter(
  options: CreateNodeRuntimeHostAdapterOptions,
): RuntimeSdkHostAdapter {
  if (!options?.providerExecutor || typeof options.providerExecutor.execute !== 'function') {
    throw new TypeError('Node Runtime Host Adapter requires providerExecutor.execute.');
  }
  if (!options.sessionProvider || typeof options.sessionProvider.getSession !== 'function') {
    throw new TypeError('Node Runtime Host Adapter requires sessionProvider.getSession.');
  }
  if (!options.resultFactory
    || typeof options.resultFactory.createPermissionGrant !== 'function'
    || typeof options.resultFactory.createFailedResult !== 'function') {
    throw new TypeError('Node Runtime Host Adapter requires resultFactory grant and failure adapters.');
  }

  return {
    hookRunner: options.hookRunner,
    executeProvider: async (request, context) => {
      const call = request.call;
      const session = options.sessionProvider.getSession();
      const locale = resolveLocale(session);
      const execution = await options.providerExecutor.execute(request, {
        ...context,
        locale,
        session,
        workspaceRoot: context.workspaceRoot ?? options.workspaceRoot,
        sessionId: request.sessionId,
        projectionId: request.projectionId,
        conversationId: request.conversationId,
      });
      return execution ?? {
        call,
        grant: options.resultFactory.createPermissionGrant({
          toolCallId: call.toolCallId,
          granted: false,
          scope: call.capabilityId,
        }),
        result: options.resultFactory.createFailedResult({
          call,
          locale,
          reason: 'unsupported_local_capability',
          dataLevel: defaultDataLevel(call),
        }),
      };
    },
    approvalPort: {
      requestApproval: async (approvalRequest, context): Promise<RuntimeSdkApprovalDecision> => {
        const call = approvalRequest.call;
        const requestPermission = (context as NodeRuntimeExecutionContext).requestPermission
          ?? options.requestPermission;
        const approval: NodeRuntimePermissionResponse | null = typeof requestPermission === 'function'
          ? await requestPermission({
              tool: call.capabilityId,
              toolName: typeof call.displayName === 'string' ? call.displayName : call.capabilityId,
              capabilityId: call.capabilityId,
              args: approvalRequest.args,
              workspacePath: approvalRequest.workspacePath ?? options.workspaceRoot,
              reason: approvalRequest.reason,
              confirmation: {
                kind: 'hook-approval',
                reason: 'hook_approval_required',
                hookEvent: 'PreToolUse',
              },
              scope: {
                kind: 'hook-approval',
                capabilityId: call.capabilityId,
              },
              riskLevel: call.riskLevel ?? 'L3_external_write',
              dataLevel: defaultDataLevel(call),
            })
          : null;
        return {
          decision: approval?.granted ? 'allow' : approval ? 'deny' : 'ask',
          approval,
        };
      },
    },
    createBlockedExecution: ({ request, decision, reason, approval }) => {
      const call = request.call;
      const session = options.sessionProvider.getSession();
      const resolvedApproval = approval?.approval as NodeRuntimePermissionResponse | null | undefined;
      const failureReason = decision === 'deny' && !resolvedApproval
        ? 'hook_denied'
        : resolvedApproval?.reason || reason;
      return {
        call,
        grant: resolvedApproval?.grant ?? options.resultFactory.createPermissionGrant({
          toolCallId: call.toolCallId,
          granted: false,
          scope: call.capabilityId,
        }),
        result: options.resultFactory.createFailedResult({
          call,
          locale: resolveLocale(session),
          reason: failureReason,
          dataLevel: defaultDataLevel(call),
        }),
      };
    },
    appendHookEvidence: options.appendHookEvidence
      ? (result, records, finalDecision): RuntimeSdkToolResult => options.appendHookEvidence!(
          result,
          records,
          finalDecision,
        )
      : undefined,
  };
}
