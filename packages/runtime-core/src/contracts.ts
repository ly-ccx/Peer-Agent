export type RuntimeCapabilityId = string;
export type RuntimeProviderId = string;
export type RuntimeRunId = string;
export type RuntimeSessionId = string;

export type RuntimeDecision = 'allow' | 'ask' | 'deny';

export type RuntimeToolStatus =
  | 'completed'
  | 'failed'
  | 'denied'
  | 'waiting_user'
  | 'timeout'
  | 'cancelled';

export type RuntimeRiskLevel =
  | 'L0_inert'
  | 'L1_readonly'
  | 'L2_low_write'
  | 'L3_sensitive'
  | 'L4_external_side_effect'
  | 'L5_destructive'
  | 'unknown';

export type RuntimeModeScope = 'chat' | 'goal' | 'plan' | 'compact' | 'system' | string;

export type RuntimeJsonObject = Readonly<Record<string, unknown>>;

export interface RuntimeWorkspaceRef {
  readonly root?: string;
  readonly id?: string;
  readonly name?: string;
}

export interface RuntimeToolCall {
  readonly toolCallId: string;
  readonly capabilityId: RuntimeCapabilityId;
  readonly name?: string;
  readonly input?: unknown;
  readonly inputPreview?: unknown;
  readonly reason?: string;
  readonly mode?: RuntimeModeScope;
  readonly metadata?: RuntimeJsonObject;
}

export interface RuntimeToolError {
  readonly code: string;
  readonly message: string;
  readonly recoverable?: boolean;
  readonly details?: unknown;
}

export interface RuntimeToolResult {
  readonly toolCallId: string;
  readonly capabilityId: RuntimeCapabilityId;
  readonly status: RuntimeToolStatus;
  readonly output?: unknown;
  readonly outputPreview?: unknown;
  readonly permissionGrant?: PermissionGrant;
  readonly evidence?: EvidenceBundle;
  readonly error?: RuntimeToolError;
  readonly metadata?: RuntimeJsonObject;
}

export interface CapabilityManifest {
  readonly capabilityId: RuntimeCapabilityId;
  readonly displayName: string;
  readonly description?: string;
  readonly riskLevel?: RuntimeRiskLevel;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly modeScopes?: readonly RuntimeModeScope[];
  readonly metadata?: RuntimeJsonObject;
}

export interface CapabilityRequest {
  readonly toolCall: RuntimeToolCall;
  readonly capabilityId: RuntimeCapabilityId;
  readonly input?: unknown;
  readonly metadata?: RuntimeJsonObject;
}

export interface CapabilityResult extends RuntimeToolResult {}

export interface CapabilityProvider {
  readonly providerId: RuntimeProviderId;
  readonly capabilities?: readonly CapabilityManifest[];
  readonly capabilityIds?: readonly RuntimeCapabilityId[];
  readonly capabilityPrefix?: string;
  canHandle?(capabilityId: RuntimeCapabilityId): boolean;
  execute(
    request: CapabilityRequest,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityResult> | CapabilityResult;
}

export interface CapabilityExecutionContext extends RuntimeExecutionContext {}

export interface RuntimeExecutionContext {
  readonly runId: RuntimeRunId;
  readonly sessionId?: RuntimeSessionId;
  readonly workspace?: RuntimeWorkspaceRef;
  readonly mode?: RuntimeModeScope;
  readonly signal?: AbortSignal;
  readonly permissions?: PermissionGateway;
  readonly hooks?: HookPipeline;
  readonly evidence?: EvidenceSink;
  readonly events?: RuntimeEventSink;
  readonly logger?: RuntimeLogger;
  readonly metadata?: RuntimeJsonObject;
}

export interface RuntimeLogger {
  debug?(message: string, metadata?: RuntimeJsonObject): void;
  info?(message: string, metadata?: RuntimeJsonObject): void;
  warn?(message: string, metadata?: RuntimeJsonObject): void;
  error?(message: string, metadata?: RuntimeJsonObject): void;
}

export interface PermissionRequest {
  readonly capabilityId: RuntimeCapabilityId;
  readonly toolCall: RuntimeToolCall;
  readonly riskLevel?: RuntimeRiskLevel;
  readonly reason?: string;
  readonly metadata?: RuntimeJsonObject;
}

export interface PermissionDecision {
  readonly decision: RuntimeDecision;
  readonly source: string;
  readonly reason?: string;
  readonly metadata?: RuntimeJsonObject;
}

export interface PermissionGrant {
  readonly grantId: string;
  readonly capabilityId: RuntimeCapabilityId;
  readonly decision: RuntimeDecision;
  readonly grantedAt: string;
  readonly source: string;
  readonly reason?: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly metadata?: RuntimeJsonObject;
}

export interface PermissionPolicy {
  readonly policyId: string;
  decide(
    request: PermissionRequest,
    context: RuntimeExecutionContext,
  ): Promise<PermissionDecision> | PermissionDecision;
}

export interface HumanApprovalRequest extends PermissionRequest {
  readonly prompt: string;
  readonly defaultDecision?: RuntimeDecision;
}

export interface HumanApprovalPort {
  requestApproval(
    request: HumanApprovalRequest,
    context: RuntimeExecutionContext,
  ): Promise<PermissionDecision> | PermissionDecision;
}

export interface PermissionGateway {
  decide(
    request: PermissionRequest,
    context: RuntimeExecutionContext,
  ): Promise<PermissionDecision> | PermissionDecision;
  createGrant?(
    decision: PermissionDecision,
    request: PermissionRequest,
    context: RuntimeExecutionContext,
  ): Promise<PermissionGrant> | PermissionGrant;
}

export type HookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact';

export type HookDecision = RuntimeDecision;

export interface HookInput {
  readonly event: HookEventName;
  readonly toolCall?: RuntimeToolCall;
  readonly toolResult?: RuntimeToolResult;
  readonly metadata?: RuntimeJsonObject;
}

export interface HookRecord {
  readonly event: HookEventName;
  readonly hookId: string;
  readonly decision: HookDecision;
  readonly reason?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly metadata?: RuntimeJsonObject;
}

export interface HookRunner {
  run(
    event: HookEventName,
    input: HookInput,
    context: RuntimeExecutionContext,
  ): Promise<readonly HookRecord[]> | readonly HookRecord[];
}

export interface HookPipeline extends HookRunner {}

export type EvidenceRef = string;

export interface EvidenceRecord {
  readonly evidenceId?: string;
  readonly kind: string;
  readonly source: string;
  readonly createdAt: string;
  readonly capabilityId?: RuntimeCapabilityId;
  readonly toolCallId?: string;
  readonly message?: string;
  readonly data?: unknown;
  readonly refs?: readonly EvidenceRef[];
  readonly metadata?: RuntimeJsonObject;
}

export interface EvidenceBundle {
  readonly records?: readonly EvidenceRecord[];
  readonly refs?: readonly EvidenceRef[];
  readonly metadata?: RuntimeJsonObject;
}

export interface EvidenceSink {
  record(
    record: EvidenceRecord,
    context: RuntimeExecutionContext,
  ): Promise<EvidenceRef> | EvidenceRef;
}

export type RuntimeEvent =
  | {
      readonly type: 'tool_call_started';
      readonly call: RuntimeToolCall;
      readonly createdAt: string;
    }
  | {
      readonly type: 'permission_decided';
      readonly call: RuntimeToolCall;
      readonly decision: PermissionDecision;
      readonly createdAt: string;
    }
  | {
      readonly type: 'tool_call_completed';
      readonly call: RuntimeToolCall;
      readonly result: RuntimeToolResult;
      readonly createdAt: string;
    }
  | {
      readonly type: 'evidence_recorded';
      readonly record: EvidenceRecord;
      readonly ref?: EvidenceRef;
      readonly createdAt: string;
    }
  | {
      readonly type: 'runtime_log';
      readonly level: 'debug' | 'info' | 'warn' | 'error';
      readonly message: string;
      readonly createdAt: string;
      readonly metadata?: RuntimeJsonObject;
    };

export interface RuntimeEventSink {
  emit(event: RuntimeEvent, context: RuntimeExecutionContext): Promise<void> | void;
}

export interface RuntimeToolDefinition {
  readonly name: string;
  readonly capabilityId: RuntimeCapabilityId;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly modeScopes?: readonly RuntimeModeScope[];
  readonly metadata?: RuntimeJsonObject;
}

export interface RuntimeProjection {
  readonly tools: readonly RuntimeToolDefinition[];
  readonly mode?: RuntimeModeScope;
  readonly createdAt?: string;
  readonly metadata?: RuntimeJsonObject;
}

export interface ProjectionMaterializer<TToolSchema = unknown> {
  readonly providerFamily: string;
  materialize(projection: RuntimeProjection): readonly TToolSchema[];
}
