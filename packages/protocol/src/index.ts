export type LocalAccessLevel =
  | 'ask_before_local'
  | 'session_local'
  | 'restricted_local'
  | 'full_local';

export type {
  ConversationLifetimeUsage,
  ProviderRequestUsage,
  RuntimeTurnUsage,
  UsageAmounts,
  UsageScope,
} from './usage-accounting.ts';

export type CapabilityRiskLevel =
  | 'L0_inert'
  | 'L1_local_read'
  | 'L2_local_write'
  | 'L3_external_write'
  | 'L4_privileged'
  | 'L5_destructive';

export type DataLevel = 'D0_public' | 'D1_internal' | 'D2_sensitive' | 'D3_private' | 'D4_regulated';

export type CapabilitySource = 'native' | 'shell' | 'plugin' | 'mcp' | 'page_bridge' | 'private' | 'web';

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
  /**
   * Optional human-readable label. For MCP tools this is `${serverName}: ${toolName}`,
   * used by the header capabilities popover to render tool rows.
   */
  readonly displayName?: string;
  /**
   * Optional provider grouping key. For MCP capabilities this is the MCP server id,
   * letting the UI aggregate every tool of one server under a single collapsible node.
   */
  readonly providerId?: string;
  /**
   * Optional provider display label (e.g. the MCP server's display name), shown as the
   * service node title when capabilities are grouped by provider.
   */
  readonly providerLabel?: string;
}

export type SkillScope = 'global' | 'workspace';

export interface SkillSummary {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  /** Layer 2 清单 reminder 的发现性提示；可为空字符串。 */
  readonly whenToUse: string;
  readonly version: string;
  readonly dataLevel: DataLevel;
  readonly enabled: boolean;
  /** Skill 的安装范围；workspace Skill 只属于对应工作空间。 */
  readonly scope: SkillScope;
  /** scope=workspace 时对应的工作空间绝对路径。 */
  readonly workspacePath?: string | null;
  /** 市场/来源图标 URL；本地 skill 可为空。 */
  readonly iconUrl?: string | null;
  /**
   * 安装来源标识。
   * 例：skillhub、aone-open；本地手工 skill 可为空。
   */
  readonly source?: string | null;
}

export interface SkillDetail extends SkillSummary {
  readonly instructions: string;
  readonly sourcePath: string;
}

/**
 * 可从外部「借用来源」（如 a1 公共 skill 仓 ~/.agents/skills）借用的技能条目。
 * linked=true 表示已在本地 userData/skills 下建立软链。
 */
export interface AvailableSkillSummary {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly dataLevel: DataLevel;
  readonly sourceRoot: string;
  readonly sourceDir: string;
  readonly linked: boolean;
}

/** linkSkill / unlinkSkill / uninstallSkill 的返回结果。 */
export interface SkillLinkResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly detail?: string;
  readonly alreadyLinked?: boolean;
  /** uninstallSkill 成功时：deleted=删除用户安装目录；unlinked=仅取消借用软链。 */
  readonly mode?: 'deleted' | 'unlinked';
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
export type McpAuthMode = 'none' | 'http_bearer' | 'http_header' | 'stdio_env' | 'oauth2';
export type McpCredentialKind = Exclude<McpAuthMode, 'none'>;

export interface McpOAuthConfigView {
  readonly authorizationServerUrl?: string;
  readonly clientId?: string;
  readonly clientSecretConfigured?: boolean;
  readonly scopes?: readonly string[];
  readonly redirectUrl?: string;
  readonly tokenStatus?: 'missing' | 'available';
  readonly expiresAt?: string;
}

export interface McpAuthBindingView {
  readonly mode: McpAuthMode;
  readonly credentialRef?: string;
  readonly headerName?: string;
  readonly envName?: string;
  readonly oauth?: McpOAuthConfigView;
}

export interface McpCredentialMetadataView {
  readonly id: string;
  readonly credentialRef: string;
  readonly label: string;
  readonly kind: McpCredentialKind;
  readonly target: 'header' | 'env' | 'oauth';
  readonly headerName?: string;
  readonly envName?: string;
  readonly oauth?: McpOAuthConfigView;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastFour?: string;
  readonly storage?: 'safeStorage' | 'file-fallback';
}

export interface McpCredentialPutRequest {
  readonly credentialRef?: string;
  readonly label?: string;
  readonly kind: McpCredentialKind;
  readonly secret?: string;
  readonly headerName?: string;
  readonly envName?: string;
  readonly oauth?: {
    readonly authorizationServerUrl?: string;
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly scopes?: readonly string[];
    readonly redirectUrl?: string;
  };
}

export interface McpOAuthLoginRequest {
  readonly serverId: string;
}

export interface McpOAuthLoginResult {
  readonly ok: boolean;
  readonly credential?: McpCredentialMetadataView;
  readonly error?: string;
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
  /** Name the MCP server reports during the initialize handshake. */
  readonly reportedName?: string | null;
  /** Version the MCP server reports during the initialize handshake. */
  readonly reportedVersion?: string | null;
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

export type McpConnectionProbeState = 'connected' | 'needs_auth' | 'failed';

export interface McpConnectionProbeAuthAction {
  readonly type: 'oauth' | 'unknown';
  readonly authorizationUrl?: string;
  readonly message?: string;
}

export interface McpConnectionProbeResult {
  readonly state: McpConnectionProbeState;
  readonly ok: boolean;
  readonly view?: LocalMcpServerView;
  readonly manifest?: McpManifestRefreshResult['manifest'];
  readonly health: McpHealthView;
  readonly toolsCount: number;
  readonly resourcesCount: number;
  readonly promptsCount: number;
  readonly auth?: McpConnectionProbeAuthAction;
  readonly message?: string;
  readonly errors?: readonly { readonly kind: string; readonly message: string }[];
}

export interface McpManifestRefreshResult {
  readonly view: LocalMcpServerView;
  readonly manifest: {
    readonly discoveredAt: string;
    readonly serverInfo?: {
      readonly name?: string;
      readonly version?: string;
    };
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
export type LlmWireProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini' | 'qoder-private';
export type LlmChannelId = string;
export type LlmReasoningParamStyle =
  | 'openai-effort'
  | 'anthropic-enabled-budget'
  | 'anthropic-adaptive-effort'
  | 'anthropic-output-effort'
  | 'qwen-enable'
  | 'none';
export type LlmReasoningEffortMap = Readonly<Record<string, string | number>>;

/**
 * 服务连接用户可见主状态（服务商中心 P0）。
 * 配置是否完整、凭据是否有效、端点是否可达、模型是否可用是内部事实；
 * UI 将这些事实归纳为少量连接状态，而不是把“已保存”当成“可用”。
 */
export type LlmConnectionState =
  | 'draft'
  | 'pending_verification'
  | 'checking'
  | 'available'
  | 'partial'
  | 'needs_attention'
  | 'unavailable'
  | 'disabled';

/** 服务模板支持级别：原生适配 / 验证兼容 / 自定义兼容 / 实验性。 */
export type LlmServiceSupportTier = 'native' | 'verified' | 'custom' | 'experimental';

/**
 * 添加服务目录的接入分类。
 * 先按接入方式分组，再展示品牌卡片。
 */
export type LlmServiceAccessCategory =
  | 'recommended'
  | 'oauth'
  | 'official_api'
  | 'cloud'
  | 'third_party'
  | 'local'
  | 'custom_compatible';

/** 阶段化诊断的检查层次。 */
export type LlmDiagnosticStageId =
  | 'config'
  | 'connectivity'
  | 'auth'
  | 'catalog'
  | 'min_inference'
  | 'agent_capability';

export type LlmDiagnosticStageStatus = 'passed' | 'failed' | 'skipped' | 'pending';

/**
 * 面向用户的错误分类（诊断 / 聊天修复共用）。
 * 技术错误码可进入 sanitizedDetail，不应直接作为主文案。
 */
export type LlmDiagnosticErrorCategory =
  | 'credential_missing'
  | 'credential_invalid'
  | 'auth_expired'
  | 'endpoint_unreachable'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'permission_denied'
  | 'model_not_found'
  | 'protocol_mismatch'
  | 'capability_mismatch'
  | 'local_runtime_stopped'
  | 'timeout'
  | 'unknown';

export interface LlmDiagnosticStage {
  readonly id: LlmDiagnosticStageId;
  readonly status: LlmDiagnosticStageStatus;
  readonly title: string;
  readonly detail?: string;
  readonly durationMs?: number;
}

export interface LlmDiagnosticSnapshot {
  readonly connectionId?: string;
  readonly configVersion?: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly trigger?: 'user' | 'background' | 'request' | 'add_flow';
  readonly stages: readonly LlmDiagnosticStage[];
  readonly errorCategory?: LlmDiagnosticErrorCategory;
  readonly sanitizedDetail?: string;
  readonly suggestedActions?: readonly string[];
}

/**
 * 服务模板：用户发现与默认配置的产品对象。
 * 一个 channel 可映射多个模板（例如 OpenAI API Key 与 ChatGPT 订阅）。
 */
export interface LlmServiceTemplateDescriptor {
  readonly id: string;
  readonly brand: string;
  readonly title: string;
  readonly description: string;
  readonly accessCategory: LlmServiceAccessCategory;
  readonly supportTier: LlmServiceSupportTier;
  readonly channelId: LlmChannelId;
  readonly authMethod: LlmAuthMethod;
  readonly legacyProvider: LlmProviderType;
  readonly defaultWire: LlmWireProtocol;
  readonly defaults: {
    readonly baseUrl: string;
    readonly model: string;
    readonly hideBaseUrlByDefault?: boolean;
  };
  readonly searchAliases?: readonly string[];
  readonly regions?: readonly string[];
  readonly tags?: readonly string[];
  readonly docsUrl?: string;
  readonly knownLimitations?: readonly string[];
}

export interface LlmChannelDescriptor {
  readonly id: LlmChannelId;
  readonly label: string;
  readonly legacyProvider: LlmProviderType;
  readonly defaultWire: LlmWireProtocol;
  readonly allowedWires: readonly LlmWireProtocol[];
  readonly defaults: {
    readonly baseUrl: string;
    readonly model: string;
  };
  readonly capabilities?: {
    readonly reasoning?: {
      readonly supported: boolean;
      readonly paramStyle: LlmReasoningParamStyle;
      readonly effortLevels?: readonly string[];
      readonly defaultEffort?: string;
      readonly effortMap?: LlmReasoningEffortMap;
    };
    readonly promptCache?: boolean;
    readonly vision?: boolean;
    readonly toolUse?: boolean;
    readonly temperature?: boolean;
  };
  readonly authMethods?: Partial<Readonly<Record<LlmAuthMethod, { readonly wire: LlmWireProtocol }>>>;
  /** 可选：将该 channel 映射到一个或多个服务模板（添加服务目录）。 */
  readonly serviceTemplates?: readonly LlmServiceTemplateDescriptor[];
}

// 鉴权方式与协议族(provider)正交(ADR 28)。
// - api_key: 用户手填 API Key,经 safeStorage 加密存储。
// - oauth_chatgpt: ChatGPT 订阅账号 OAuth 登录,access/refresh token 存 main 进程,
//   订阅模型走 OpenAI Responses 传输。
// - oauth_google: Google OAuth 登录,access/refresh token 存 main 进程,
//   Gemini 模型走 Google Generative Language API 传输。
// - oauth_grok: Grok Build 订阅账号设备码登录,token 存 main 进程。
// - qoder_local_auth: 复用本机 Qoder 登录态/token,不在 Peer Agent 内保存远端密钥。
// - local_cli: 旧配置兼容值,读取时迁移到 qoder_local_auth。
export type LlmAuthMethod = 'api_key' | 'oauth_chatgpt' | 'oauth_google' | 'oauth_grok' | 'qoder_local_auth' | 'local_cli';

// 订阅(OAuth)登录态投影。token 永不回传 renderer,仅以状态 + 账号标识表达。
export type LlmOAuthConnectionStatus = 'connected' | 'expired' | 'disconnected';

export interface LlmOAuthStatus {
  readonly status: LlmOAuthConnectionStatus;
  readonly accountId?: string;
  readonly expiresAt?: string;
}

/** 订阅额度窗口（session / weekly / model 等）。 */
export interface LlmSubscriptionQuotaWindow {
  readonly id: string;
  readonly label?: string;
  readonly remainingPercent?: number;
  readonly usedPercent?: number;
  readonly resetsAt?: string;
}

/**
 * GPT / Gemini / Grok / Qoder 订阅额度快照。
 * success=false 时用 status/error 表达未登录、过期或拉取失败，UI 应降级展示。
 */
export interface LlmSubscriptionQuota {
  readonly success: boolean;
  readonly status?: string;
  readonly providerId?: string;
  readonly authMethod?: LlmAuthMethod;
  readonly provider?: 'chatgpt' | 'gemini' | 'grok' | 'qoder' | string;
  readonly planLabel?: string;
  readonly remainingPercent?: number;
  readonly usedPercent?: number;
  readonly resetsAt?: string;
  readonly windows?: readonly LlmSubscriptionQuotaWindow[];
  readonly accountId?: string;
  readonly projectId?: string;
  readonly fetchedAt?: string;
  readonly cached?: boolean;
  readonly error?: string;
  // Qoder 信用点数 / 资源包绝对值（可选；百分比字段仍保留供通用 UI）。
  readonly availableCredits?: number;
  readonly planCreditsUsed?: number;
  readonly planCreditsTotal?: number;
  readonly orgPackageUsed?: number;
  readonly orgPackageCap?: number;
}

export interface LlmProviderConfig {
  readonly id: string;
  // B-2 多模型分组键：同 groupId 的扁平记录共享同一 provider 凭证（apiKey/baseUrl/OAuth），
  // 各自是该 provider 下的一个模型。缺省时（旧数据迁移前）视为自成一组。
  // 前端据此把同组记录折叠成一张手风琴卡；聊天区仍在打平的 provider×model 里平铺切换。
  readonly groupId?: string;
  readonly provider: LlmProviderType;
  readonly channelId?: LlmChannelId;
  readonly resolvedWire?: LlmWireProtocol;
  readonly wireOverride?: LlmWireProtocol;
  readonly authMethod: LlmAuthMethod;
  readonly name: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly modelLabel?: string;
  // 模型元数据来源：渠道目录、models.dev 补全、本机/内置目录，或用户手动维护。
  readonly metadataSource?: 'remote' | 'models.dev' | 'builtin' | 'local' | 'manual';
  // models.dev-reference 表示参考模型价格，不代表代理渠道的实际结算价格。
  readonly pricingSource?: 'provider' | 'models.dev-reference';
  readonly metadataSyncedAt?: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly modelOptions?: readonly LlmModelOptionDefinition[];
  readonly modelOptionValues?: LlmModelOptionValues;
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
  readonly reasoningParamStyle?: LlmReasoningParamStyle;
  readonly reasoningEffortMap?: LlmReasoningEffortMap;
  // 该 provider 原生支持的思考强度档位（来自 channel capabilities，未含归一化）。
  // 前端据此渲染档位选择器；缺省时前端回退到通用四档。
  readonly reasoningEffortLevels?: readonly string[];
  /** 渠道默认思考强度（如 Grok 为 high）。UI 切模型时用于落到正确默认档。 */
  readonly reasoningDefaultEffort?: string;
  readonly oauthProjectId?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly customHeadersInvalid?: boolean;
  /**
   * 服务模板 ID（服务商中心）。
   * 旧配置可缺省；UI/迁移层按 channelId+authMethod 回填。
   */
  readonly serviceTemplateId?: string;
  /** 服务连接用户可见状态；缺省时由 UI/服务层按凭据与诊断推导。 */
  readonly connectionState?: LlmConnectionState;
  readonly connectionStateReason?: string;
  /** 配置版本：诊断结果必须绑定版本，避免旧结果污染新配置。 */
  readonly configVersion?: number;
  readonly lastCheckedAt?: string;
  readonly lastSuccessAt?: string;
  readonly lastErrorCategory?: LlmDiagnosticErrorCategory;
}

export interface LlmProviderConfigView extends LlmProviderConfig {
  readonly apiKeyMasked: string;
  readonly apiKeyConfigured: boolean;
  // OAuth 渠道登录后存在,仅表达登录态而不暴露 token。
  readonly oauthStatus?: LlmOAuthStatus;
  // 仅存在于「聊天列表展开」出的虚拟记录（订阅/多模型）：其复合 id 在存储里不存在，
  // 凭证解析/刷新据此回退到原始记录 id 取 OAuth token / apiKey。普通记录不带此字段。
  readonly credentialId?: string;
  /** 最近一次脱敏诊断快照（可选）。 */
  readonly lastDiagnostic?: LlmDiagnosticSnapshot;
}

// ── Provider 多模型（父子）模型 ─────────────────────────────────────────────
// 一个 provider（父）共享鉴权与接入信息（apiKey / baseUrl / OAuth），
// 其下挂多个模型（子），每个模型各自持有模型级参数（上下文/定价/推理/自定义 Header）。
// 存储层以此父子结构落盘，但 listProviders() 仍向下游打平成 provider×model 组合
// （复合 id = groupId::modelId），以最小化聊天路由 / 凭证解析 / 聊天区的改动面。

// 模型子项：仅承载模型级参数，不含任何鉴权字段。
export interface LlmModelConfig {
  // 模型子项在其 provider 组内的唯一标识（组内稳定，不含 provider 前缀）。
  readonly id: string;
  readonly model: string;
  // 展示名（缺省时前端回退到 model 本身）。
  readonly label?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly resolvedWire?: LlmWireProtocol;
  readonly wireOverride?: LlmWireProtocol;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
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
  readonly reasoningParamStyle?: LlmReasoningParamStyle;
  readonly reasoningEffortMap?: LlmReasoningEffortMap;
  readonly reasoningEffortLevels?: readonly string[];
  /** 渠道默认思考强度（如 Grok 为 high）。 */
  readonly reasoningDefaultEffort?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly customHeadersInvalid?: boolean;
}

// provider 组（父）：共享鉴权与接入信息，其下挂 models[]。
export interface LlmProviderGroupConfig {
  readonly id: string;
  readonly provider: LlmProviderType;
  readonly channelId?: LlmChannelId;
  readonly authMethod: LlmAuthMethod;
  readonly name: string;
  readonly baseUrl: string;
  readonly createdAt: string;
  readonly oauthProjectId?: string;
  readonly models: readonly LlmModelConfig[];
}

// provider 组视图：附带脱敏后的 apiKey 状态与订阅登录态。
export interface LlmProviderGroupConfigView extends LlmProviderGroupConfig {
  readonly apiKeyMasked: string;
  readonly apiKeyConfigured: boolean;
  readonly oauthStatus?: LlmOAuthStatus;
  // 全局唯一默认模型的复合 id（groupId::modelId）；无默认时缺省。
  readonly defaultComboId?: string;
}

// 渠道声明、通用层持久化和 Renderer 渲染共用的可序列化模型选项。
// 通用层只理解控件与值；requestValue 及预算字段由渠道适配器解释并投影。
export type LlmModelOptionValue = string | number | boolean;

export interface LlmModelOptionChoice {
  readonly value: LlmModelOptionValue;
  readonly label: string;
  readonly description?: string;
  readonly requestValue?: LlmModelOptionValue;
  readonly contextWindow?: number;
  readonly inputTokenLimit?: number;
}

export interface LlmModelOptionDefinition {
  readonly id: string;
  readonly label: string;
  readonly kind: 'select';
  readonly description?: string;
  readonly defaultValue: LlmModelOptionValue;
  readonly choices: readonly LlmModelOptionChoice[];
}

export type LlmModelOptionValues = Readonly<Record<string, LlmModelOptionValue>>;

export function resolveLlmModelOptionValues(
  definitions: readonly LlmModelOptionDefinition[] | undefined,
  values: LlmModelOptionValues | undefined,
): LlmModelOptionValues {
  if (!definitions?.length) return {};
  const resolved: Record<string, LlmModelOptionValue> = {};
  for (const definition of definitions) {
    const selected = values?.[definition.id] ?? definition.defaultValue;
    const valid = definition.choices.some((choice) => choice.value === selected);
    resolved[definition.id] = valid ? selected : definition.defaultValue;
  }
  return resolved;
}

export function resolveLlmModelOptionChoice(
  definition: LlmModelOptionDefinition,
  values: LlmModelOptionValues | undefined,
): LlmModelOptionChoice | undefined {
  const selected = resolveLlmModelOptionValues([definition], values)[definition.id];
  return definition.choices.find((choice) => choice.value === selected);
}

// ADR 28: 订阅(OAuth)登录后从远程拉取的可用模型项。
export interface LlmModelInfo {
  readonly id: string;
  readonly label: string;
  // 模型创建时间戳(秒),用于"最新"排序;远程未提供时缺省。
  readonly created?: number;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly modelOptions?: readonly LlmModelOptionDefinition[];
  readonly modelOptionValues?: LlmModelOptionValues;
  readonly supportsVision?: boolean;
  readonly supportsReasoning?: boolean;
  // 元数据可由渠道直返或 models.dev 精确模型 ID 补全；渠道字段始终优先。
  readonly metadataSource?: 'provider' | 'models.dev';
  // models.dev 价格是模型参考价，不代表当前代理渠道的实际结算价格。
  readonly pricingSource?: 'provider' | 'models.dev-reference';
  // USD per 1M tokens unless otherwise noted by the provider.
  readonly inputPrice?: number;
  readonly outputPrice?: number;
  readonly cacheReadPrice?: number;
  readonly cacheWritePrice?: number;
  readonly longContextInputThreshold?: number;
  readonly longContextInputPrice?: number;
  readonly longContextCacheReadPrice?: number;
  readonly longContextOutputPrice?: number;
  // Qoder CLI 积分倍率：当前结算倍率 / 原价倍率（如 0.25x ← 0.50x 表示折扣中）。
  readonly priceFactor?: number;
  readonly originalPriceFactor?: number;
}

// 列模型结果。source 标明数据来源:
// - 'builtin' : 订阅(codex 平面)内置权威目录,平面无列模型接口,内置即真值。
// - 'remote'  : 通过 provider 的公开远程接口或官方 SDK 动态拉取。
// - 'fallback': 远程失败后的兜底(保留以兼容历史诊断语义)。
// - 'local'   : 从本机 provider 登录态/cache 派生的目录。
export interface LlmModelListResult {
  readonly success: boolean;
  readonly models: readonly LlmModelInfo[];
  readonly source?: 'builtin' | 'remote' | 'fallback' | 'local';
  readonly error?: string;
}

// 用表单临时配置(未落盘的 provider)直接拉模型的请求参数。
// 与 LlmModelListResult(按已落盘 provider id 拉)正交:这里传的是 channelId/baseUrl/apiKey
// 等原始字段,main 层用 resolveChannel 解析后调 listOpenAICompatibleModels。
export interface LlmModelFetchRequest {
  readonly channelId?: string;
  readonly wireOverride?: string;
  /** Qoder 私有接口等本机鉴权渠道需要显式传入，避免 fetch 路径被默认当成 api_key。 */
  readonly authMethod?: LlmAuthMethod;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly customHeaders?: Record<string, string>;
}

export interface LlmProviderTestResult {
  readonly success: boolean;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly error?: string;
  /** 面向用户的错误分类；缺省时 UI 可回退到 unknown。 */
  readonly errorCategory?: LlmDiagnosticErrorCategory;
  /** 阶段化诊断结果（配置 / 网络 / 认证 / 目录 / 最小请求…）。 */
  readonly stages?: readonly LlmDiagnosticStage[];
  readonly diagnostic?: LlmDiagnosticSnapshot;
  /** 测试后推导出的连接状态建议。 */
  readonly connectionState?: LlmConnectionState;
  readonly connectionStateReason?: string;
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

export interface ClientToolConfirmation {
  readonly kind: string;
  readonly detail?: string;
  readonly reason?: string;
  readonly riskLevel?: CapabilityRiskLevel;
  readonly [key: string]: unknown;
}

export interface RuntimeToolCall {
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly arguments?: unknown;
  readonly argumentsPreview?: unknown;
  readonly [key: string]: unknown;
}

export interface RuntimeToolResult {
  readonly toolCallId?: string;
  readonly status?: string;
  readonly evidence?: unknown;
  readonly [key: string]: unknown;
}

export interface RuntimeExecuteRequest {
  readonly sessionId?: string;
  readonly projectionId?: string;
  readonly conversationId?: string;
  readonly call: RuntimeToolCall;
  readonly [key: string]: unknown;
}

export interface RuntimeExecutionContext {
  readonly workspaceRoot?: string;
  readonly [key: string]: unknown;
}

export interface ClientToolCall extends RuntimeToolCall {
  readonly displayName: string;
  readonly reason: string;
  readonly arguments?: Record<string, unknown>;
  readonly argumentsPreview: Record<string, unknown>;
  readonly confirmation?: ClientToolConfirmation;
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
export * from './compaction.ts';
export * from './context-accounting.ts';
export * from './memory.ts';
export * from './system-context.ts';
export * from './goal.ts';
export * from './acceptance-close-gate.ts';
export * from './acceptance-basis.ts';
export * from './updater.ts';
export * from './appshot.ts';
export * from './automation.ts';
export * from './task-overview.ts';
export * from './skill-marketplace.ts';
