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

export type McpTransportKind = 'streamable_http' | 'sse' | 'stdio';
export type McpHealthStatus = 'unknown' | 'ok' | 'failed';
export type McpAuthMode = 'none' | 'http_bearer' | 'http_header' | 'stdio_env';
export type McpCredentialKind = Exclude<McpAuthMode, 'none'>;

export interface McpAuthBindingView {
  readonly mode: McpAuthMode;
  readonly credentialRef?: string;
  readonly headerName?: string;
  readonly envName?: string;
}

export interface McpCredentialMetadataView {
  readonly id: string;
  readonly credentialRef: string;
  readonly label: string;
  readonly kind: McpCredentialKind;
  readonly target: 'header' | 'env';
  readonly headerName?: string;
  readonly envName?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastFour?: string;
  readonly storage?: 'safeStorage' | 'file-fallback';
}

export interface McpCredentialPutRequest {
  readonly credentialRef?: string;
  readonly label?: string;
  readonly kind: McpCredentialKind;
  readonly secret: string;
  readonly headerName?: string;
  readonly envName?: string;
}

export interface McpHealthView {
  readonly status: McpHealthStatus;
  readonly checkedAt?: string | null;
  readonly message?: string;
}

export interface McpToolSummary {
  readonly name: string;
  readonly description?: string;
  readonly visible?: boolean;
  readonly inputSchema?: JsonSchemaLike;
}

export interface McpResourceSummary {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpPromptSummary {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly Record<string, unknown>[];
}

export interface LocalMcpServerView {
  readonly id: string;
  readonly mcpId: string;
  readonly displayName: string;
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly transport: McpTransportKind;
  readonly commandPreview?: string;
  readonly urlPreview?: string;
  readonly serverUrl?: string;
  readonly auth?: McpAuthBindingView;
  readonly toolsCount: number;
  readonly visibleToolsCount: number;
  readonly resourcesCount: number;
  readonly promptsCount: number;
  readonly tools: readonly McpToolSummary[];
  readonly resources: readonly McpResourceSummary[];
  readonly prompts: readonly McpPromptSummary[];
  readonly health: McpHealthView;
  readonly manifestUpdatedAt?: string | null;
  readonly lastError?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface LocalMcpServerUpsertRequest {
  readonly id?: string;
  readonly mcpId?: string;
  readonly displayName?: string;
  readonly name?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly transport: McpTransportKind;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string | null;
  readonly env?: Record<string, string>;
  readonly url?: string;
  readonly serverUrl?: string;
  readonly headers?: Record<string, string>;
  readonly auth?: McpAuthBindingView;
}

export interface McpConnectionTestResult {
  readonly ok: boolean;
  readonly health: McpHealthView;
  readonly toolsCount: number;
  readonly resourcesCount: number;
  readonly promptsCount: number;
  readonly errors?: readonly { readonly kind: string; readonly message: string }[];
}

export interface McpManifestRefreshResult {
  readonly view: LocalMcpServerView;
  readonly manifest: {
    readonly discoveredAt: string;
    readonly tools: readonly McpToolSummary[];
    readonly resources: readonly McpResourceSummary[];
    readonly prompts: readonly McpPromptSummary[];
    readonly errors?: readonly { readonly kind: string; readonly message: string }[];
    readonly health: McpHealthView;
  };
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

// 鉴权方式与协议族(provider)正交(ADR 28)。
// - api_key: 用户手填 API Key,经 safeStorage 加密存储。
// - oauth_chatgpt: ChatGPT 订阅账号 OAuth 登录,access/refresh token 存 main 进程,
//   订阅模型走 OpenAI Responses 传输。
export type LlmAuthMethod = 'api_key' | 'oauth_chatgpt';

// 订阅(OAuth)登录态投影。token 永不回传 renderer,仅以状态 + 账号标识表达。
export type LlmOAuthConnectionStatus = 'connected' | 'expired' | 'disconnected';

export interface LlmOAuthStatus {
  readonly status: LlmOAuthConnectionStatus;
  readonly accountId?: string;
  readonly expiresAt?: string;
}

export interface LlmProviderConfig {
  readonly id: string;
  readonly provider: LlmProviderType;
  readonly authMethod: LlmAuthMethod;
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
  readonly longContextInputThreshold?: number;
  readonly longContextInputPrice?: number;
  readonly longContextCacheReadPrice?: number;
  readonly longContextOutputPrice?: number;
  readonly supportsVision?: boolean;
  readonly supportsReasoning?: boolean;
  readonly supportsPromptCaching?: boolean;
}

export interface LlmProviderConfigView extends LlmProviderConfig {
  readonly apiKeyMasked: string;
  readonly apiKeyConfigured: boolean;
  // 仅当 authMethod === 'oauth_chatgpt' 时存在,表达订阅登录态。
  readonly oauthStatus?: LlmOAuthStatus;
}

// ADR 28: 订阅(OAuth)登录后从远程拉取的可用模型项。
export interface LlmModelInfo {
  readonly id: string;
  readonly label: string;
  // 模型创建时间戳(秒),用于"最新"排序;远程未提供时缺省。
  readonly created?: number;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  // USD per 1M tokens unless otherwise noted by the provider.
  readonly inputPrice?: number;
  readonly outputPrice?: number;
  readonly cacheReadPrice?: number;
  readonly longContextInputThreshold?: number;
  readonly longContextInputPrice?: number;
  readonly longContextCacheReadPrice?: number;
  readonly longContextOutputPrice?: number;
}

// 列模型结果。source 标明数据来源:
// - 'builtin' : 订阅(codex 平面)内置权威目录,平面无列模型接口,内置即真值。
// - 'remote'  : 自带 API key 时从 /v1/models 动态拉取。
// - 'fallback': 远程失败后的兜底(保留以兼容历史诊断语义)。
export interface LlmModelListResult {
  readonly success: boolean;
  readonly models: readonly LlmModelInfo[];
  readonly source?: 'builtin' | 'remote' | 'fallback';
  readonly error?: string;
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
export * from './system-context.ts';
