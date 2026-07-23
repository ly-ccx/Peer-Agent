import type {
  RuntimeSdkApprovalDecision,
  RuntimeSdkExecuteRequest,
  RuntimeSdkExecutionContext,
  RuntimeSdkHookRunner,
  RuntimeSdkPermissionRequest,
  RuntimeSdkProviderExecution,
  RuntimeSdkToolCall,
  RuntimeSdkToolResult,
} from '@peer-agent/runtime-sdk';

export interface NodeRuntimeSession {
  readonly locale?: string;
  readonly [key: string]: unknown;
}

export interface NodeRuntimePermissionResponse {
  readonly granted: boolean;
  readonly grant?: unknown;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export interface NodeRuntimeHookPermissionPrompt {
  readonly tool: string;
  readonly toolName: string;
  readonly capabilityId: string;
  readonly args: unknown;
  readonly workspacePath?: string;
  readonly reason: string;
  readonly confirmation: {
    readonly kind: 'hook-approval';
    readonly reason: 'hook_approval_required';
    readonly hookEvent: 'PreToolUse';
  };
  readonly scope: {
    readonly kind: 'hook-approval';
    readonly capabilityId: string;
  };
  readonly riskLevel: unknown;
  readonly dataLevel: unknown;
}

export interface NodeRuntimeCapabilityPermissionPrompt {
  readonly tool: string;
  readonly toolName: string;
  readonly capabilityId: string;
  readonly args: unknown;
  readonly workspacePath: string;
  readonly reason: string;
  readonly confirmation: {
    readonly kind: 'capability-approval';
    readonly approvalKind: 'file-write' | 'shell-exec' | 'web-fetch';
    readonly reason: string;
  };
  readonly scope: {
    readonly kind: 'capability-approval';
    readonly capabilityId: string;
    readonly workspaceRoot: string;
  };
  readonly riskLevel: string;
  readonly dataLevel: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type NodeRuntimePermissionPrompt =
  | NodeRuntimeHookPermissionPrompt
  | NodeRuntimeCapabilityPermissionPrompt;

export interface NodeRuntimeExecutionContext extends RuntimeSdkExecutionContext {
  readonly requestPermission?: (
    request: NodeRuntimePermissionPrompt,
  ) => Promise<NodeRuntimePermissionResponse> | NodeRuntimePermissionResponse;
}

export interface NodeRuntimeProviderExecutor {
  execute(
    request: RuntimeSdkExecuteRequest,
    context: NodeRuntimeExecutionContext & {
      readonly locale?: string;
      readonly session: NodeRuntimeSession;
      readonly workspaceRoot?: string;
      readonly sessionId?: string;
      readonly projectionId?: string;
      readonly conversationId?: string;
    },
  ): Promise<RuntimeSdkProviderExecution | null | undefined> | RuntimeSdkProviderExecution | null | undefined;
}

export interface NodeRuntimeResultFactory {
  createPermissionGrant(options: {
    readonly toolCallId: string;
    readonly granted: boolean;
    readonly scope: string;
  }): unknown;
  createFailedResult(options: {
    readonly call: RuntimeSdkToolCall;
    readonly locale?: string;
    readonly reason: string;
    readonly dataLevel: unknown;
  }): RuntimeSdkToolResult;
}

export interface CreateNodeRuntimeHostAdapterOptions {
  readonly workspaceRoot?: string;
  readonly providerExecutor: NodeRuntimeProviderExecutor;
  readonly sessionProvider: {
    getSession(): NodeRuntimeSession;
  };
  readonly resultFactory: NodeRuntimeResultFactory;
  readonly requestPermission?: NodeRuntimeExecutionContext['requestPermission'];
  readonly hookRunner?: RuntimeSdkHookRunner | null;
  readonly appendHookEvidence?: (
    result: RuntimeSdkToolResult,
    records: readonly Record<string, unknown>[],
    finalDecision: 'allow' | 'ask' | 'deny',
  ) => RuntimeSdkToolResult;
}

export interface NodeRuntimeApprovalDecision extends RuntimeSdkApprovalDecision {
  readonly approval?: NodeRuntimePermissionResponse | null;
}

export type NodeRuntimeApprovalRequest = RuntimeSdkPermissionRequest;
