import type { RuntimeDecision } from '@peer-agent/runtime-core';
import type {
  ContextAccountingSnapshot,
  RuntimeExecuteRequest,
  RuntimeExecutionContext,
  RuntimeToolCall,
  RuntimeToolResult,
} from '@peer-agent/protocol';

export type {
  RuntimeExecuteRequest,
  RuntimeExecutionContext,
  RuntimeToolCall,
  RuntimeToolResult,
} from '@peer-agent/protocol';

export const RUNTIME_EVENT_PROTOCOL_VERSION = 1 as const;

export type RuntimeEventProtocolVersion = typeof RUNTIME_EVENT_PROTOCOL_VERSION;

export type RuntimeSdkEventType =
  | 'session.started'
  | 'message.delta'
  | 'reasoning.delta'
  | 'message.completed'
  | 'runtime.error'
  | 'tool.started'
  | 'hook.completed'
  | 'permission.requested'
  | 'permission.resolved'
  | 'tool.completed'
  | 'compaction.progress'
  | 'context.accounting';

export type RuntimeSdkToolCall = RuntimeToolCall;
export type RuntimeSdkExecuteRequest = RuntimeExecuteRequest;
export type RuntimeSdkExecutionContext = RuntimeExecutionContext;
export type RuntimeSdkToolResult = RuntimeToolResult;

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

export interface RuntimeSdkEventBase {
  readonly protocolVersion: RuntimeEventProtocolVersion;
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly sessionId?: string;
  readonly streamId?: string;
  readonly projectionId?: string;
  readonly conversationId?: string;
  readonly toolCallId?: string;
  readonly capabilityId?: string;
}

export interface RuntimeSdkSessionStartedEvent extends RuntimeSdkEventBase {
  readonly type: 'session.started';
  readonly sessionId: string;
  readonly streamId?: string;
  readonly mode?: string;
  readonly providerId?: string;
  readonly model?: string;
}

export interface RuntimeSdkMessageDeltaEvent extends RuntimeSdkEventBase {
  readonly type: 'message.delta';
  readonly streamId: string;
  readonly content: string;
}

export interface RuntimeSdkReasoningDeltaEvent extends RuntimeSdkEventBase {
  readonly type: 'reasoning.delta';
  readonly streamId: string;
  readonly content: string;
}

/**
 * Mid-turn / automatic compaction progress for host UI surfaces.
 * percent is 0-100; hosts should treat values below 100 as live progress.
 */
export interface RuntimeSdkCompactionProgressEvent extends RuntimeSdkEventBase {
  readonly type: 'compaction.progress';
  readonly streamId: string;
  readonly percent: number;
  readonly reason?: 'preflight' | 'overflow' | 'manual' | string;
  readonly phase?: 'started' | 'progress' | 'done';
  readonly label?: string;
}

/** Shared Desktop/TUI context-capacity state. Presentation consumes this verbatim. */
export interface RuntimeSdkContextAccountingEvent extends RuntimeSdkEventBase {
  readonly type: 'context.accounting';
  readonly snapshot: ContextAccountingSnapshot;
}

export interface RuntimeSdkMessageCompletedEvent extends RuntimeSdkEventBase {
  readonly type: 'message.completed';
  readonly streamId: string;
  readonly content?: string;
  readonly usage?: unknown;
  readonly lifetimeUsage?: unknown;
  readonly finishReason?: string;
}

export interface RuntimeSdkRuntimeErrorEvent extends RuntimeSdkEventBase {
  readonly type: 'runtime.error';
  readonly code: string;
  readonly message?: string;
  readonly recoverable?: boolean;
  readonly details?: unknown;
}

export interface RuntimeSdkToolStartedEvent extends RuntimeSdkEventBase {
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly type: 'tool.started';
}

export interface RuntimeSdkHookCompletedEvent extends RuntimeSdkEventBase {
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly type: 'hook.completed';
  readonly phase: 'PreToolUse' | 'PostToolUse';
  readonly decision: RuntimeDecision;
  readonly records: readonly RuntimeSdkHookRecord[];
}

export interface RuntimeSdkPermissionRequestedEvent extends RuntimeSdkEventBase {
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly type: 'permission.requested';
  readonly decision: 'ask';
}

export interface RuntimeSdkPermissionResolvedEvent extends RuntimeSdkEventBase {
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly type: 'permission.resolved';
  readonly decision: RuntimeDecision;
}

export interface RuntimeSdkToolCompletedEvent extends RuntimeSdkEventBase {
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly type: 'tool.completed';
  readonly decision: RuntimeDecision;
  readonly result: RuntimeSdkToolResult;
}

export type RuntimeSdkEvent =
  | RuntimeSdkSessionStartedEvent
  | RuntimeSdkMessageDeltaEvent
  | RuntimeSdkReasoningDeltaEvent
  | RuntimeSdkCompactionProgressEvent
  | RuntimeSdkContextAccountingEvent
  | RuntimeSdkMessageCompletedEvent
  | RuntimeSdkRuntimeErrorEvent
  | RuntimeSdkToolStartedEvent
  | RuntimeSdkHookCompletedEvent
  | RuntimeSdkPermissionRequestedEvent
  | RuntimeSdkPermissionResolvedEvent
  | RuntimeSdkToolCompletedEvent;

export type RuntimeSdkEventInput = RuntimeSdkEvent extends infer Event
  ? Event extends RuntimeSdkEvent
    ? Omit<Event, 'protocolVersion' | 'eventId' | 'sequence' | 'occurredAt'>
    : never
  : never;

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
  emit(event: RuntimeSdkEventInput): RuntimeSdkEvent;
  subscribe(listener: RuntimeSdkEventListener): () => void;
}
