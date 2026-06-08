import type {
  AuthState,
  CapabilityManifest,
  ClientBootstrap,
  ClientSessionState,
  ClientToolCall,
  ClientToolResult,
  CloudContractProbeReport,
  CloudRuntimeState,
  DeveloperDiagnostics,
  DeveloperSettingsState,
  LocaleCode,
  PermissionGrant,
  RuntimeProjection,
  RuntimeProjectionPublishResult,
  SkillSummary,
  WorkspaceProject,
} from '@zeus-atlas/protocol';
import type { PreloadResult } from './apiResponse';

export interface BootstrapPreloadApi {
  readonly getBootstrap: () => Promise<ClientBootstrap>;
  readonly getClientSession: () => Promise<ClientSessionState>;
  readonly listCapabilities: () => Promise<readonly CapabilityManifest[]>;
  readonly listProjects: () => Promise<readonly WorkspaceProject[]>;
  readonly getCloudRuntime: () => Promise<CloudRuntimeState>;
  readonly probeCloudContracts: () => Promise<CloudContractProbeReport>;
  readonly getDeveloperSettings: () => Promise<DeveloperSettingsState>;
  readonly updateDeveloperSettings: (settings: Partial<DeveloperSettingsState['settings']>) => Promise<DeveloperSettingsState>;
  readonly resetDeveloperSettings: () => Promise<DeveloperSettingsState>;
  readonly getDeveloperDiagnostics: () => Promise<DeveloperDiagnostics>;
  readonly getRuntimeProjection: () => Promise<RuntimeProjection>;
  readonly publishRuntimeProjection: () => PreloadResult<RuntimeProjectionPublishResult>;
  readonly getAuthState: () => Promise<AuthState>;
  readonly login: () => Promise<AuthState>;
  readonly cancelLogin: () => Promise<AuthState>;
  readonly logout: () => Promise<AuthState>;
  readonly setLocale: (locale: LocaleCode) => Promise<ClientSessionState>;
  readonly approveLocalAction: (toolCallId: string) => Promise<PermissionGrant>;
  readonly denyLocalAction: (toolCallId: string) => Promise<PermissionGrant>;
  readonly executeClientToolCall: (
    call: ClientToolCall,
    grant?: PermissionGrant
  ) => Promise<{
    readonly call: ClientToolCall;
    readonly grant: PermissionGrant;
    readonly result: ClientToolResult;
  }>;
  readonly runHealthCheck: (toolCallId: string) => Promise<ClientToolResult>;
  readonly searchStaff: (params: { query: string }) => Promise<readonly { nickname: string; employeeId: string; realName?: string; email?: string }[]>;
  readonly listShellTasks: () => Promise<readonly Record<string, unknown>[]>;
  readonly stopActiveShellTask: () => Promise<Record<string, unknown>>;
  readonly stopShellTask: (taskId: string) => Promise<Record<string, unknown>>;
  readonly listShellPermissionRules: () => Promise<readonly Record<string, unknown>[]>;
  readonly addShellPermissionRule: (rule: Record<string, unknown>) => Promise<readonly Record<string, unknown>[]>;
  readonly listSkills: () => Promise<readonly SkillSummary[]>;
  readonly refreshSkills: () => Promise<readonly SkillSummary[]>;
  readonly uploadSkill: (zipBase64: string) => Promise<SkillSummary | null>;
  readonly enableSkill: (skillId: string) => Promise<readonly SkillSummary[]>;
  readonly disableSkill: (skillId: string) => Promise<readonly SkillSummary[]>;
  readonly mcpListInstalled: () => Promise<readonly McpLocalRegistryItem[]>;
  readonly mcpInstall: (item: McpLocalRegistryItem) => Promise<readonly McpLocalRegistryItem[]>;
  readonly mcpUninstall: (params: { mcpId: number }) => Promise<readonly McpLocalRegistryItem[]>;
  readonly mcpListDingtalkMarket: (params: { keyword?: string; pageSize?: number }) => Promise<readonly McpDingtalkMarketItem[]>;
  readonly mcpGetDingtalkDetail: (params: { mcpId: number }) => Promise<McpDingtalkMarketDetail | null>;
  readonly mcpProbe: (params: { serverUrl?: string; workId?: string; serviceId?: number }) => Promise<McpProbeResult | null>;
  readonly mcpListAoneMarket: (params: { keyword?: string; pageSize?: number; pageNo?: number; resourceType?: string }) => Promise<McpAoneMarketResult>;
  readonly mcpListAoneMcpServers: (params: { keyword?: string; page?: number; pageSize?: number; clientId?: string; empId?: string }) => Promise<McpAoneMcpServersResult>;
  readonly mcpGetAoneMcpDetail: (params: { serverName: string; env?: string }) => Promise<McpAoneMcpServerDetail | null>;
  readonly mcpDingtalkActivate: (params: { mcpId: number }) => Promise<McpDingtalkActivationResponse>;
  readonly mcpDingtalkAuthStatus: () => Promise<{ authenticated: boolean }>;
  readonly mcpConnectAndRegister: (params: { serverUrl: string; serverName: string }) => Promise<{ success: boolean; toolCount: number }>;
  readonly skillListDingtalkMarket: (params: { keyword?: string; page?: number; pageSize?: number }) => Promise<SkillDingtalkMarketResult>;
  readonly skillListAoneMarket: (params: { keyword?: string; pn?: number; rn?: number }) => Promise<SkillAoneMarketResult>;
  readonly skillAoneEnsureAuth: () => Promise<{ status: 'ready' | 'login_required' }>;
  readonly skillAoneLogin: () => Promise<boolean>;
  readonly skillInstallAone: (params: { name: string }) => Promise<unknown>;
  readonly skillInstallDingtalk: (params: { skillId: string; name: string }) => Promise<unknown>;
  /** ~/.zeusos/settings.json 首屏同步快照（preload 启动时同步读一次，避免主题闪烁）。 */
  readonly initialSettings: Record<string, unknown>;
  /** 读取统一用户设置（appearance / appMode / ...）。 */
  readonly getSettings: () => Promise<Record<string, unknown>>;
  /** 浅合并写入统一用户设置，返回合并后的完整设置。 */
  readonly updateSettings: (partial: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** 一键导出 portable 配置到用户选定目录。 */
  readonly exportConfig: () => Promise<{ canceled: boolean; exported: readonly string[]; targetDir?: string | null }>;
  /** 一键从用户选定目录导入 portable 配置（覆盖现有）。 */
  readonly importConfig: () => Promise<{ canceled: boolean; imported: readonly string[] }>;
}

export interface McpLocalRegistryItem {
  readonly mcpId: number;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly providerCorpName?: string;
  readonly source: 'dingtalk' | 'aone' | 'custom';
  readonly serverUrl?: string;
  readonly tools: readonly { toolName: string; toolDesc?: string }[];
  readonly dingtalkActivation?: McpDingtalkActivationInfo;
  readonly installedAt?: string;
}

export interface McpDingtalkActivationInfo {
  readonly instanceId?: number;
  readonly mcpInstanceId?: string;
  readonly mcpJSON?: string;
  readonly serverUrl?: string;
  readonly activatedAt?: string;
  readonly raw?: Record<string, unknown>;
}

export interface McpDingtalkActivationResponse {
  readonly success?: boolean;
  readonly result?: McpDingtalkActivationResult;
  readonly errorMsg?: string;
}

export interface McpDingtalkActivationResult {
  readonly instanceId?: number;
  readonly mcpId?: number;
  readonly mcpInstanceId?: string;
  readonly mcpJSON?: string;
  readonly [key: string]: unknown;
}

export interface McpDingtalkMarketItem {
  readonly mcpId: number;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly providerCorpName?: string;
  readonly installed?: boolean;
}

export interface McpDingtalkMarketDetail {
  readonly mcpId: number;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly providerCorpName?: string;
  readonly introduction?: string;
  readonly tools: readonly { toolName: string; toolDesc?: string; inputSchema?: Record<string, unknown> }[];
  readonly dingtalkActivation?: McpDingtalkActivationInfo;
}

export interface McpAoneMarketResult {
  readonly needsAuth: boolean;
  readonly list: readonly McpAoneMarketItem[];
}

export interface McpAoneMarketItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly provider?: string;
  readonly source: 'aone';
  readonly resourceType?: string;
  readonly latestVersion?: string;
  readonly tarballUrl?: string;
  readonly fileUrl?: string;
}

export interface McpAoneMcpServersResult {
  readonly list: readonly McpAoneMcpServerItem[];
  readonly total: number;
}

export interface McpAoneMcpServerItem {
  readonly code: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly ownerEmpId?: string;
  readonly platformCode?: string;
  readonly usageCount: number;
  readonly toolsCount: number;
  readonly mcpType?: string;
}

export interface McpAoneMcpServerDetail {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly icon?: string;
  readonly readme?: string;
  readonly status?: string;
  readonly type?: string;
  readonly creator?: string;
  readonly tools: readonly { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
}

export interface McpProbeResult {
  readonly serverInfo: { name: string; version?: string; protocolVersion?: string };
  readonly tools: readonly { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
}

export interface SkillDingtalkMarketItem {
  readonly id: number;
  readonly skillId: string;
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly developerName?: string;
  readonly installCount?: number;
  readonly categories?: readonly { categoryCode: string; categoryName: string }[];
  readonly tags?: readonly string[];
  readonly dependentServices?: readonly { name: string; description?: string; icon?: string; toolId: number; toolType: string; charged: boolean; installed: boolean }[];
}

export interface SkillDingtalkMarketResult {
  readonly currentPage: number;
  readonly pageSize: number;
  readonly totalCount: number;
  readonly totalPages: number;
  readonly values: readonly SkillDingtalkMarketItem[];
}

export interface SkillAoneMarketItem {
  readonly id: string;
  readonly name: string;
  readonly code?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly ownerEmpId?: string;
  readonly ownerName?: string;
  readonly favoriteCount?: number;
  readonly usageCount?: number;
  readonly platformName?: string;
  readonly abilityType?: string;
}

export interface SkillAoneMarketResult {
  readonly pn: number;
  readonly rn: number;
  readonly total: number;
  readonly totalPages: number;
  readonly items: readonly SkillAoneMarketItem[];
}
