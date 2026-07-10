import type { RuntimeDecision } from '@peer-agent/runtime-core';

export type RuntimeSdkEventType =
  | 'tool.started'
  | 'hook.completed'
  | 'permission.requested'
  | 'permission.resolved'
  | 'tool.completed';

export interface RuntimeSdkToolCall {
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly arguments?: unknown;
  readonly argumentsPreview?: unknown;
  readonly [key: string]: unknown;
}

export interface RuntimeSdkExecuteRequest {
  readonly sessionId?: string;
  readonly projectionId?: string;
  readonly conversationId?: string;
  readonly call: RuntimeSdkToolCall;
  readonly [key: string]: unknown;
}

export interface RuntimeSdkExecutionContext {
  readonly workspaceRoot?: string;
  readonly [key: string]: unknown;
}

export interface RuntimeSdkToolResult {
  readonly toolCallId?: string;
  readonly status?: string;
  readonly evidence?: unknown;
  readonly [key: string]: unknown;
}

export interface RuntimeSdkProviderExecution {
  readonly result: RuntimeSdkToolResult;
  readonly [key: string]: unknown;
}

export interface RuntimeSdkHookRecord {
  readonly hookId?: string;
  readonly decision?: RuntimeDecision;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export interface RuntimeSdkHookPayload {
  readonly sessionId?: string;
  readonly projectionId?: string;
  readonly conversationId?: string;
  readonly call: RuntimeSdkToolCall;
  readonly result?: RuntimeSdkToolResult;
}

export interface RuntimeSdkHookRunner {
  runPreToolUse?(payload: RuntimeSdkHookPayload): Promise<readonly RuntimeSdkHookRecord[]> | readonly RuntimeSdkHookRecord[];
  runPostToolUse?(payload: RuntimeSdkHookPayload): Promise<readonly RuntimeSdkHookRecord[]> | readonly RuntimeSdkHookRecord[];
}

export interface RuntimeSdkPermissionRequest {
  readonly kind: 'hook';
  readonly hookEvent: 'PreToolUse';
  readonly call: RuntimeSdkToolCall;
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly args: unknown;
  readonly workspacePath?: string;
  readonly reason: string;
}

export interface RuntimeSdkApprovalDecision {
  readonly decision: RuntimeDecision;
  readonly [key: string]: unknown;
}

export interface RuntimeSdkApprovalPort {
  requestApproval(
    request: RuntimeSdkPermissionRequest,
    context: RuntimeSdkExecutionContext,
  ): Promise<RuntimeSdkApprovalDecision> | RuntimeSdkApprovalDecision;
}

export interface RuntimeSdkHostAdapter {
  executeProvider(
    request: RuntimeSdkExecuteRequest,
    context: RuntimeSdkExecutionContext,
  ): Promise<RuntimeSdkProviderExecution> | RuntimeSdkProviderExecution;
  createBlockedExecution(options: {
    readonly request: RuntimeSdkExecuteRequest;
    readonly context: RuntimeSdkExecutionContext;
    readonly decision: RuntimeDecision;
    readonly reason: string;
    readonly approval?: RuntimeSdkApprovalDecision;
  }): RuntimeSdkProviderExecution;
  appendHookEvidence?(
    result: RuntimeSdkToolResult,
    records: readonly RuntimeSdkHookRecord[],
    finalDecision: RuntimeDecision,
  ): RuntimeSdkToolResult;
  hookRunner?: RuntimeSdkHookRunner | null;
  approvalPort?: RuntimeSdkApprovalPort | null;
}

export interface RuntimeSdkEvent {
  readonly sequence: number;
  readonly type: RuntimeSdkEventType;
  readonly occurredAt: string;
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly decision?: RuntimeDecision;
  readonly phase?: 'PreToolUse' | 'PostToolUse';
  readonly records?: readonly RuntimeSdkHookRecord[];
  readonly result?: RuntimeSdkToolResult;
}

export type RuntimeSdkEventListener = (event: RuntimeSdkEvent) => void;

export interface RuntimeSdkOptions {
  readonly host: RuntimeSdkHostAdapter;
  readonly workspaceRoot?: string;
  readonly now?: () => string;
}

export interface RuntimeSdk {
  execute(
    request: RuntimeSdkExecuteRequest,
    context?: RuntimeSdkExecutionContext,
  ): Promise<RuntimeSdkProviderExecution>;
  subscribe(listener: RuntimeSdkEventListener): () => void;
}
