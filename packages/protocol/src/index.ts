export type LocalAccessLevel =
  | 'ask_before_local'
  | 'session_local'
  | 'restricted_local'
  | 'full_local';

export type CapabilityRiskLevel =
  | 'L0_inert'
  | 'L1_local_read'
  | 'L2_local_write'
  | 'L3_external_write'
  | 'L4_privileged'
  | 'L5_destructive';

export type DataLevel = 'D0_public' | 'D1_internal' | 'D2_sensitive' | 'D3_private' | 'D4_regulated';

export type CapabilitySource = 'native' | 'shell' | 'plugin' | 'mcp' | 'page_bridge' | 'private';

export type CapabilityHealth = 'available' | 'needs_permission' | 'policy_disabled' | 'local_disabled' | 'unhealthy';

export type LocaleCode = 'zh-CN' | 'en-US';

export type LocalizedText = Partial<Record<LocaleCode, string>>;

export interface JsonSchemaLike {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchemaLike>;
  readonly required?: readonly string[];
  readonly items?: JsonSchemaLike;
  readonly enum?: readonly string[];
  readonly description?: string;
}

export interface EvidencePolicy {
  readonly returnMode: 'none' | 'summary' | 'diff' | 'redacted_output' | 'artifact_ref';
  readonly maxChars?: number;
  readonly redactSensitive: boolean;
}

export interface CapabilityManifest {
  readonly capabilityId: string;
  readonly name: string;
  readonly description: string;
  readonly localizedName?: LocalizedText;
  readonly localizedDescription?: LocalizedText;
  readonly source: CapabilitySource;
  readonly riskLevel: CapabilityRiskLevel;
  readonly dataLevel: DataLevel;
  readonly health: CapabilityHealth;
  readonly inputSchema: JsonSchemaLike;
  readonly evidencePolicy: EvidencePolicy;
}

export interface SkillSummary {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly dataLevel: DataLevel;
  readonly enabled: boolean;
}

export interface RuntimeProjection {
  readonly projectionId: string;
  readonly sessionId: string;
  readonly accessLevel: LocalAccessLevel;
  readonly capabilities: readonly CapabilityManifest[];
  readonly skills?: readonly SkillSummary[];
  readonly createdAt: string;
}

export interface ClientSessionState {
  readonly sessionId: string;
  readonly status: 'local_ready' | 'hybrid_ready' | 'permission_required' | 'degraded' | 'offline';
  readonly accessLevel: LocalAccessLevel;
  readonly capabilityCount: number;
  readonly pendingReviewCount: number;
  readonly locale: LocaleCode;
  readonly workspaceLabel?: string;
}

export interface GitProjectState {
  readonly branch?: string;
  readonly remote?: string;
  readonly modifiedCount: number;
  readonly untrackedCount: number;
  readonly stagedCount: number;
  readonly ahead: number;
  readonly behind: number;
  readonly isDirty: boolean;
}

export interface WorkspaceProject {
  readonly projectId: string;
  readonly name: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly kind: 'workspace_root' | 'workspace_package' | 'directory';
  readonly packageName?: string;
  readonly git?: GitProjectState;
  readonly updatedAt: string;
}

export type LlmProviderType = 'openai' | 'anthropic';

export interface LlmProviderConfig {
  readonly id: string;
  readonly provider: LlmProviderType;
  readonly name: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly contextWindow?: number;
  readonly inputPrice?: number;
  readonly outputPrice?: number;
  readonly cacheWritePrice?: number;
  readonly cacheReadPrice?: number;
}

export interface LlmProviderConfigView extends LlmProviderConfig {
  readonly apiKeyMasked: string;
  readonly apiKeyConfigured: boolean;
}

export interface LlmProviderTestResult {
  readonly success: boolean;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly error?: string;
}

export interface ClientBootstrap {
  readonly session: ClientSessionState;
  readonly capabilities: readonly CapabilityManifest[];
  readonly projects: readonly WorkspaceProject[];
  readonly activeProjectId: string;
  readonly availableLocales: readonly LocaleCode[];
  readonly llmProviders: readonly LlmProviderConfigView[];
}

export interface CapabilitySelection {
  readonly capabilityId: string;
  readonly reason: string;
  readonly argumentsPreview: Record<string, unknown>;
}

export interface ClientToolCall {
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly displayName: string;
  readonly reason: string;
  readonly arguments?: Record<string, unknown>;
  readonly argumentsPreview: Record<string, unknown>;
  readonly riskLevel: CapabilityRiskLevel;
  readonly dataLevel: DataLevel;
  readonly requestedAt: string;
}

export interface ClientToolCallPollRequest {
  readonly sessionId: string;
  readonly projectionId?: string;
  readonly conversationId?: number;
  readonly cursor?: string;
  readonly limit?: number;
  readonly polledAt: string;
}

export interface ClientToolCallPollResult {
  readonly calls: readonly ClientToolCall[];
  readonly cursor?: string;
  readonly idleUntil?: string;
}

export type PermissionDuration = 'once' | 'task' | 'session' | 'scope' | 'persistent' | 'denied';

export interface PermissionGrant {
  readonly grantId: string;
  readonly toolCallId: string;
  readonly granted: boolean;
  readonly duration: PermissionDuration;
  readonly scope?: string;
  readonly decidedAt: string;
}

export interface LocalShellExecInput {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly description?: string;
  readonly runInBackground?: boolean;
}

export interface LocalShellStopInput {
  readonly taskId?: string;
  readonly toolCallId?: string;
}

export interface LocalShellExecResult {
  readonly status: 'success' | 'failed' | 'cancelled' | 'running';
  readonly exitCode: number | null;
  readonly stdoutPreview: string | null;
  readonly stderrPreview: string | null;
  readonly interrupted: boolean;
  readonly timedOut: boolean;
  readonly promptDetected: boolean;
  readonly outputArtifactRef?: string | null;
  readonly backgroundTaskId?: string | null;
}

export type ShellPermissionBehavior = 'allow' | 'ask' | 'deny';

export interface ShellPermissionRule {
  readonly id?: string;
  readonly behavior: ShellPermissionBehavior;
  readonly match:
  | { readonly type: 'exact'; readonly command: string }
  | { readonly type: 'prefix'; readonly prefix: string }
  | { readonly type: 'wildcard'; readonly pattern: string };
  readonly scope: {
    readonly cwd?: string;
    readonly maxRiskLevel?: CapabilityRiskLevel;
  };
  readonly expiresAt?: string;
}

export interface LocalShellProjectionPolicy {
  readonly capabilityId: 'local.shell.exec';
  readonly cwdScope: 'workspace' | 'selected_directories';
  readonly defaultBehavior: 'ask' | 'deny';
  readonly readOnlyAutoAllow: boolean;
  readonly backgroundTasks: boolean;
  readonly sandboxAvailable: boolean;
}

export interface Evidence {
  readonly evidenceId: string;
  readonly toolCallId: string;
  readonly summary: string;
  readonly locale: LocaleCode;
  readonly returnedToCloud: boolean;
  readonly dataLevel: DataLevel;
  readonly redactions: readonly string[];
  readonly artifactRefs: readonly string[];
}

export interface ClientToolResult {
  readonly toolCallId: string;
  readonly status: 'success' | 'denied' | 'failed' | 'cancelled';
  readonly outputPreview: Record<string, unknown>;
  readonly evidence: Evidence;
  readonly completedAt: string;
}

export interface ClientToolResultReport {
  readonly conversationId?: number;
  readonly streamId?: string;
  readonly call: ClientToolCall;
  readonly grant: PermissionGrant;
  readonly result: ClientToolResult;
  readonly reportedAt: string;
}

export interface AuditEvent {
  readonly auditId: string;
  readonly sessionId: string;
  readonly eventType:
  | 'session_started'
  | 'manifest_published'
  | 'permission_reviewed'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed';
  readonly message: string;
  readonly createdAt: string;
  readonly metadata?: Record<string, unknown>;
}

export * from './execution.ts';
export * from './chat.ts';
export * from './memory.ts';
