import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBucAuthService } from './buc-auth-service.mjs';
import { createCapabilityRegistry } from './capability-registry.mjs';
import { createCloudChatService } from './cloud-chat-service.mjs';
import { probeCloudContracts } from './cloud-contract-probe.mjs';
import { createDeveloperSettingsStore } from './developer-settings-store.mjs';
import { loadLocalEnv } from './env-loader.mjs';
import { readCloudRuntimeState } from './cloud-runtime.mjs';
import { runHealthStub } from './core-health.mjs';
import { readProjectIndex } from './project-index.mjs';
import { createSessionStore } from './session-store.mjs';
import { createLocalToolHost } from './runtime-gateway/local-tool-host.mjs';
import { createLocalShellProvider } from './runtime-gateway/local-shell-provider.mjs';
import { createLocalSkillProvider } from './runtime-gateway/local-skill-provider.mjs';
import { createSkillStore } from './skill-store.mjs';
import { createShellEnvSnapshot } from './runtime-gateway/shell-env-snapshot.mjs';
import { getZeusHome, migrateFromLegacy, exportBundle, importBundle } from './zeus-store.mjs';
import { createSettingsStore } from './settings-store.mjs';
import { createMcpMarketService } from './mcp-market-service.mjs';
import { createSkillMarketService } from './skill-market-service.mjs';
import { createMcpRegistry } from './mcp-registry.mjs';
import { normalizeMcpServersAsCapabilities } from './client-runtime-chat-context.mjs';
import { createDingtalkAuthService } from './dingtalk-auth-service.mjs';
import { initAutoUpdater, registerUpdaterIPC } from './auto-updater.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Packaged vs Development mode path resolution ──
// In packaged mode (app.isPackaged), resources live under process.resourcesPath.
// In dev mode, we walk up to the workspace root (pnpm-workspace.yaml).
function findWorkspaceRoot(startDir) {
  let current = startDir;
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(__dirname, '../../..');
}

const isPackaged = app.isPackaged;
const workspaceRoot = isPackaged ? null : findWorkspaceRoot(__dirname);
// resourcesRoot: where extraResources (bin/, capabilities/) live after packaging
const resourcesRoot = isPackaged ? process.resourcesPath : workspaceRoot;
const loadedEnvKeys = isPackaged ? [] : loadLocalEnv({ workspaceRoot });
// 诊断日志：定位 BUC client_id is not configured 根因。
// 输出 workspaceRoot 实际路径、loadLocalEnv 加载到的 key 列表、关键变量最终值。
console.log('[env-diag] workspaceRoot=', workspaceRoot ?? '(packaged)');
console.log('[env-diag] resourcesRoot=', resourcesRoot);
console.log('[env-diag] loadedEnvKeys=', loadedEnvKeys);
console.log('[env-diag] ZEUS_ATLAS_BUC_CLIENT_ID=', JSON.stringify(process.env.ZEUS_ATLAS_BUC_CLIENT_ID));
console.log('[env-diag] ZEUS_ATLAS_BUC_ENV=', JSON.stringify(process.env.ZEUS_ATLAS_BUC_ENV));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const availableLocales = ['zh-CN', 'en-US'];
const desktopIconPath = workspaceRoot
  ? path.join(workspaceRoot, 'apps/desktop/build/icon.png')
  : null;

function getDesktopIconPath() {
  return desktopIconPath && existsSync(desktopIconPath) ? desktopIconPath : undefined;
}

function setDockIcon() {
  const iconPath = getDesktopIconPath();
  if (process.platform === 'darwin' && iconPath && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }
}

// Dev-mode 判定:打包后 app.isPackaged=true,走真实审批;unpackaged(npm run dev)
// 或显式 ZEUS_ATLAS_DEVELOPER_MODE 都视为开发模式,渲染层会自动放行 shell 工具。
const explicitDevModeFlag =
  typeof process.env.ZEUS_ATLAS_DEVELOPER_MODE === 'string' &&
  process.env.ZEUS_ATLAS_DEVELOPER_MODE.trim() !== '' &&
  process.env.ZEUS_ATLAS_DEVELOPER_MODE.trim() !== '0' &&
  process.env.ZEUS_ATLAS_DEVELOPER_MODE.trim().toLowerCase() !== 'false';
const isDevMode = explicitDevModeFlag || app.isPackaged === false;
console.log('[main] dev-mode resolution:', {
  explicitDevModeFlag,
  isPackaged: app.isPackaged,
  isDevMode,
});
// 宙斯统一数据根 ~/.zeusos：与 Electron userData / app 标识解耦，改名/升级/重装都不丢。
// 启动即把旧 Electron userData 里的业务数据一次性搬过来（幂等、copy 保留回退）。
const zeusHome = getZeusHome();
{
  let legacyUserData = null;
  try {
    legacyUserData = app.getPath('userData');
  } catch {
    /* app ready 前取不到 userData：跳过迁移源，新数据仍正常落 ~/.zeusos */
  }
  migrateFromLegacy(legacyUserData);
}

// 用户设置统一存储（~/.zeusos/settings.json）——收口 renderer 侧 appearance/appMode 等，
// 供 settings:get/update IPC 读写；preload 另有同步读用于首屏。
const settingsStore = createSettingsStore();

const capabilityRegistry = createCapabilityRegistry({ workspaceRoot: resourcesRoot });
const sessionStore = createSessionStore({
  workspaceRoot: resourcesRoot,
  userDataPath: zeusHome,
  listCapabilities: capabilityRegistry.listCapabilities,
  // 启动恢复 locale：优先 ~/.zeusos/settings.json，回落环境变量
  preferredLocale: settingsStore.getAll().locale ?? process.env.ZEUS_ATLAS_LOCALE,
});
let authService;
let cloudChatService;
let developerSettingsStore;
let skillStore;

function getDeveloperSettingsStore() {
  if (!developerSettingsStore) {
    developerSettingsStore = createDeveloperSettingsStore({ userDataPath: zeusHome });
  }
  return developerSettingsStore;
}

function getEffectiveEndpointConfig() {
  return getDeveloperSettingsStore().getEffectiveCloudEndpointConfig();
}

function getAuthService() {
  if (!authService) {
    authService = createBucAuthService({ userDataPath: zeusHome });
  }
  return authService;
}

function getCloudChatService() {
  if (!cloudChatService) {
    cloudChatService = createCloudChatService({
      getAccessToken: () => getAuthService().getAccessToken(),
      getEndpointConfig: getEffectiveEndpointConfig,
      getSession: () => sessionStore.getSession(),
      buildRuntimeProjection,
    });
  }
  return cloudChatService;
}

function buildRuntimeProjection() {
  const session = sessionStore.getSession();
  const installed = mcpRegistry.listInstalled();
  const mcpServers = installed.map((item) => ({
    mcpId: item.mcpId,
    name: item.name,
    source: item.source,
    serverUrl: item.serverUrl,
    enabled: item.enabled,
    tools: (item.tools || []).map((t) => ({
      toolName: t.toolName || t.name || '',
      toolDesc: t.toolDesc || t.description || '',
    })),
    dingtalkActivation: item.dingtalkActivation,
  }));
  const baseCapabilities = capabilityRegistry.refreshCapabilities();
  const mcpCapabilities = normalizeMcpServersAsCapabilities(mcpServers);
  // 合并进 projection.capabilities，使 projection-guard 能识别 local.mcp.* 调用。
  const seen = new Set(baseCapabilities.map((c) => c.capabilityId));
  const mergedCapabilities = [
    ...baseCapabilities,
    ...mcpCapabilities.filter((c) => !seen.has(c.capabilityId)),
  ];
  return {
    projectionId: session.sessionId,
    sessionId: session.sessionId,
    accessLevel: session.accessLevel,
    capabilities: mergedCapabilities,
    skills: skillStore?.listSkills() ?? [],
    mcpServers,
    createdAt: new Date().toISOString(),
  };
}

function sanitizeFilename(filename) {
  const fallback = `zeus-chat-statistics-${new Date().toISOString().slice(0, 10)}.json`;
  const cleaned = String(filename || fallback)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 180);
  return cleaned || fallback;
}

async function saveChatStatisticsSnapshot(payload) {
  const format = payload?.format === 'csv' ? 'csv' : 'json';
  const content = typeof payload?.content === 'string' ? payload.content : '';
  if (!content.trim()) {
    throw new Error('Chat statistics export content is empty.');
  }

  const result = await dialog.showSaveDialog({
    title: 'Export Chat Statistics',
    defaultPath: sanitizeFilename(payload?.filename),
    filters: [
      format === 'csv'
        ? { name: 'CSV', extensions: ['csv'] }
        : { name: 'JSON', extensions: ['json'] },
    ],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });

  if (result.canceled || !result.filePath) {
    return {
      saved: false,
      cancelled: true,
      reportType: 'statistics_snapshot',
      format,
    };
  }

  await writeFile(result.filePath, content, 'utf8');
  return {
    saved: true,
    filePath: result.filePath,
    bytes: Buffer.byteLength(content, 'utf8'),
    reportType: 'statistics_snapshot',
    format,
    savedAt: new Date().toISOString(),
  };
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1040,
    minHeight: 720,
    title: '1688 宙斯-员工版',
    backgroundColor: '#1e1e2e',
    titleBarStyle: 'hiddenInset',
    icon: getDesktopIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 启用 <webview>，用于「飞轮」模式嵌入 Zeus 工作台（绕开 X-Frame-Options）
      webviewTag: true,
    },
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    // 打包态: dist/ 与 electron/ 同层平放; 开发态: 从 workspace root 解析
    const indexPath = isPackaged
      ? path.join(__dirname, '../../dist/index.html')
      : path.join(workspaceRoot, 'apps/desktop/dist/index.html');
    void mainWindow.loadFile(indexPath);
  }
}

ipcMain.handle('bootstrap:get', async () => ({
  session: sessionStore.getSession(),
  auth: await getAuthService().getAuthState(),
  capabilities: capabilityRegistry.refreshCapabilities(),
  projects: readProjectIndex({ workspaceRoot: resourcesRoot }),
  activeProjectId: 'workspace-root',
  cloudRuntime: readCloudRuntimeState({ getEndpointConfig: getEffectiveEndpointConfig }),
  availableLocales,
  runtime: { isDevMode },
}));

ipcMain.handle('session:get', () => sessionStore.getSession());

ipcMain.handle('capabilities:list', () => capabilityRegistry.refreshCapabilities());

// ── MCP Market ──
let mcpMarketService;
function getMcpMarketService() {
  if (!mcpMarketService) {
    mcpMarketService = createMcpMarketService({
      getAccessToken: () => getAuthService().getAccessToken(),
      getEndpointConfig: getEffectiveEndpointConfig,
    });
  }
  return mcpMarketService;
}
const mcpRegistry = createMcpRegistry();
const dingtalkAuth = createDingtalkAuthService();
ipcMain.handle('mcp:list-installed', () => mcpRegistry.listInstalled());
ipcMain.handle('mcp:install', (_, item) => mcpRegistry.install(item));
ipcMain.handle('mcp:uninstall', (_, params) => mcpRegistry.uninstall(params.mcpId));
ipcMain.handle('mcp:list-dingtalk-market', async (_, params) => {
  const list = await getMcpMarketService().listDingtalkMarket(params);
  const localItems = mcpRegistry.listInstalled();
  const localMcpIds = new Set(localItems.map((i) => i.mcpId));
  return list.map((item) => ({
    ...item,
    installed: Boolean(item.installed) || localMcpIds.has(item.mcpId),
  }));
});
ipcMain.handle('mcp:get-dingtalk-detail', (_, params) => getMcpMarketService().getDingtalkDetail(params));
ipcMain.handle('mcp:probe', (_, params) => getMcpMarketService().probeMcpServer(params));
ipcMain.handle('mcp:list-aone-market', (_, params) => getMcpMarketService().listAoneMarket(params));
ipcMain.handle('mcp:list-aone-mcp-servers', (_, params) => getMcpMarketService().listAoneMcpServers(params));
ipcMain.handle('mcp:get-aone-mcp-detail', (_, params) => getMcpMarketService().getAoneMcpServerDetail(params));
ipcMain.handle('mcp:dingtalk-activate', (_, params) => dingtalkAuth.activate(params.mcpId));
ipcMain.handle('mcp:dingtalk-auth-status', () => dingtalkAuth.getAuthStatus());
ipcMain.handle('mcp:dingtalk-logout', () => dingtalkAuth.logout());

// ── MCP Connect (SDK + OAuth 2.1) ──
import { createElectronOAuthProvider } from './mcp-oauth-provider.mjs';
import { listMcpTools, disconnectMcp } from './mcp-client.mjs';

function stableHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h) + 100000;
}

ipcMain.handle('mcp:connect-and-register', async (_, { serverUrl, serverName }) => {
  if (!serverUrl || !serverName) throw new Error('serverUrl and serverName are required');

  const authProvider = await createElectronOAuthProvider(serverUrl);
  let tools;
  try {
    tools = await listMcpTools(serverUrl, authProvider);
  } finally {
    authProvider.close();
  }

  mcpRegistry.install({
    mcpId: stableHash(serverName),
    name: serverName,
    source: 'aone',
    serverUrl,
    tools: tools.map((t) => ({ toolName: t.name, toolDesc: t.description })),
  });

  disconnectMcp(serverUrl);
  return { success: true, toolCount: tools.length };
});

// ── Skill Market ──
const skillMarketService = createSkillMarketService({
  getAccessToken: () => getAuthService().getAccessToken(),
  downloadDingtalkFile: (url) => dingtalkAuth.downloadFile(url),
});
ipcMain.handle('skill:list-dingtalk-market', (_, params) => skillMarketService.listDingtalkSkillMarket(params));
ipcMain.handle('skill:list-aone-market', (_, params) => skillMarketService.listAoneSkillMarket(params));
ipcMain.handle('skill:aone-ensure-auth', () => skillMarketService.ensureAoneAuth());
ipcMain.handle('skill:aone-login', () => skillMarketService.loginAone());
ipcMain.handle('skill:install-aone', async (_, { name, ...others }) => {
  if (!skillStore) throw new Error('skill_store_not_available');
  const { buffer } = await skillMarketService.installAoneSkill(name, others);
  return skillStore.installSkillFromTgz(buffer);
});
ipcMain.handle('skill:install-dingtalk', async (_, { skillId, name }) => {
  if (!skillStore) throw new Error('skill_store_not_available');
  const { buffer } = await skillMarketService.installDingtalkSkill(skillId);
  return skillStore.installSkillFromZip(buffer);
});

ipcMain.handle('projects:list', () => readProjectIndex({ workspaceRoot: resourcesRoot }));

ipcMain.handle('cloud-runtime:get', () =>
  readCloudRuntimeState({ getEndpointConfig: getEffectiveEndpointConfig }),
);

ipcMain.handle('cloud-contracts:probe', () =>
  probeCloudContracts({ getEndpointConfig: getEffectiveEndpointConfig }),
);

ipcMain.handle('developer-settings:get', () => getDeveloperSettingsStore().getState());

ipcMain.handle('developer-settings:update', (_event, payload) =>
  getDeveloperSettingsStore().updateSettings(payload),
);

ipcMain.handle('developer-settings:reset', () => getDeveloperSettingsStore().resetSettings());

// 用户设置（appearance / appMode / ...）统一读写，落 ~/.zeusos/settings.json
ipcMain.handle('settings:get', () => settingsStore.getAll());
ipcMain.handle('settings:update', (_event, partial) => settingsStore.merge(partial));
// preload 首屏同步读取（sendSync）—— 让 preload 不必 require fs（sandbox 下会崩）
ipcMain.on('settings:get-sync', (event) => {
  event.returnValue = settingsStore.getAll();
});

// 一键配置导出/导入（仅 scope=portable：skills/permissions/settings/developer-settings）
ipcMain.handle('settings:export', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择导出目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths?.[0]) return { canceled: true, exported: [] };
  return { canceled: false, ...exportBundle(filePaths[0]) };
});
ipcMain.handle('settings:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择要导入的配置目录',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths?.[0]) return { canceled: true, imported: [] };
  return { canceled: false, ...importBundle(filePaths[0]) };
});

ipcMain.handle('developer-settings:diagnostics', () => ({
  cloudRuntime: readCloudRuntimeState({ getEndpointConfig: getEffectiveEndpointConfig }),
  lastRequest: cloudChatService?.requestDiagnostic?.() ?? null,
}));

ipcMain.handle('runtime-projection:get', () => buildRuntimeProjection());

ipcMain.handle('runtime-projection:publish', () => {
  const projects = readProjectIndex({ workspaceRoot: resourcesRoot });
  const session = sessionStore.getSession();
  return getCloudChatService().publishRuntimeProjection({
    projection: buildRuntimeProjection(),
    session,
    workspace: projects[0],
    publishedAt: new Date().toISOString(),
  });
});

ipcMain.handle('auth:get', () => getAuthService().getAuthState());

ipcMain.handle('auth:login', () => getAuthService().login());

ipcMain.handle('auth:cancel-login', () => getAuthService().cancelLogin());

ipcMain.handle('auth:logout', () => getAuthService().logout());

ipcMain.handle('chat:conversations:list', (_event, payload) =>
  getCloudChatService().listConversations(payload),
);

ipcMain.handle('chat:conversations:create', (_event, payload) =>
  getCloudChatService().createConversation(payload),
);

ipcMain.handle('chat:conversations:detail', (_event, payload) =>
  getCloudChatService().getConversationDetail(payload),
);

ipcMain.handle('chat:conversations:delete', (_event, payload) =>
  getCloudChatService().deleteConversation(payload),
);

ipcMain.handle('chat:conversations:branch-from-message', (_event, payload) =>
  getCloudChatService().branchFromMessage(payload),
);

ipcMain.handle('chat:messages:list', (_event, payload) =>
  getCloudChatService().getMessages(payload),
);

ipcMain.handle('chat:messages:detail', (_event, payload) =>
  getCloudChatService().getMessageDetail(payload),
);

ipcMain.handle('chat:messages:context', (_event, payload) =>
  getCloudChatService().buildMessageContext(payload),
);

ipcMain.handle('chat:messages:last', (_event, payload) =>
  getCloudChatService().getLastMessage(payload),
);

ipcMain.handle('chat:messages:delete', (_event, payload) =>
  getCloudChatService().deleteMessage(payload),
);

ipcMain.handle('chat:messages:truncate-after', (_event, payload) =>
  getCloudChatService().truncateAfterMessage(payload),
);

ipcMain.handle('chat:image:upload', (_event, payload) =>
  getCloudChatService().uploadImage(payload),
);

ipcMain.handle('chat:messages:stream-start', (event, payload) => {
  return getCloudChatService().startMessageStream({
    webContents: event.sender,
    params: payload,
  });
});

ipcMain.handle('chat:messages:stream-abort', (_event, payload) =>
  getCloudChatService().abortMessageStream(payload),
);

ipcMain.handle('chat:messages:cancel', (_event, payload) =>
  getCloudChatService().cancelStream(payload),
);

ipcMain.handle('chat:execution:confirm', (_event, payload) =>
  getCloudChatService().confirmExecution(payload),
);

ipcMain.handle('chat:execution:status', (_event, payload) =>
  getCloudChatService().getExecutionStatus(payload),
);

ipcMain.handle('chat:execution:detail', (_event, payload) =>
  getCloudChatService().getExecutionDetail(payload),
);

ipcMain.handle('chat:execution:result', (_event, payload) =>
  getCloudChatService().getExecutionResult(payload),
);

ipcMain.handle('chat:execution:cot', (_event, payload) =>
  getCloudChatService().getExecutionCot(payload),
);

ipcMain.handle('chat:execution:source-trace', (_event, payload) =>
  getCloudChatService().traceExecutionSource(payload),
);

ipcMain.handle('chat:execution:list', (_event, payload) =>
  getCloudChatService().listExecutions(payload),
);

ipcMain.handle('chat:execution:shadow-related', (_event, payload) =>
  getCloudChatService().listRelatedShadowExecutions(payload),
);

ipcMain.handle('chat:execution:cancel', (_event, payload) =>
  getCloudChatService().cancelExecution(payload),
);

ipcMain.handle('chat:dispatch:pending', (_event, payload) =>
  getCloudChatService().getPendingDispatch(payload),
);

ipcMain.handle('chat:dispatch:confirm', (_event, payload) =>
  getCloudChatService().confirmDispatch(payload),
);

ipcMain.handle('chat:execution:poll', (_event, payload) =>
  getCloudChatService().pollExecutionEvents(payload),
);

ipcMain.handle('chat:thinking:detail', (_event, payload) =>
  getCloudChatService().getThinkingDetail(payload),
);

ipcMain.handle('chat:thinking:ui-state:update', (_event, payload) =>
  getCloudChatService().updateThinkingUiState(payload),
);

ipcMain.handle('chat:assistant:suggestions', (_event, payload) =>
  getCloudChatService().getAssistantSuggestions(payload),
);

ipcMain.handle('chat:assistant:inline-completion', (_event, payload) =>
  getCloudChatService().getInlineCompletion(payload),
);

ipcMain.handle('chat:agents:get', (_event, payload) =>
  getCloudChatService().getAgentById(payload),
);

ipcMain.handle('chat:agents:list', (_event, payload) =>
  getCloudChatService().listAgents(payload),
);

ipcMain.handle('chat:memory:working:get', (_event, payload) =>
  getCloudChatService().getWorkingMemory(payload),
);

ipcMain.handle('chat:memory:working:initialize', (_event, payload) =>
  getCloudChatService().initializeWorkingMemory(payload),
);

ipcMain.handle('chat:memory:wiki:status', (_event, payload) =>
  getCloudChatService().getMemoryWikiStatus(payload),
);

ipcMain.handle('chat:memory:wiki:pages', (_event, payload) =>
  getCloudChatService().listMemoryWikiPages(payload),
);

ipcMain.handle('chat:memory:wiki:page', (_event, payload) =>
  getCloudChatService().readMemoryWikiPage(payload),
);

ipcMain.handle('chat:memory:wiki:initialize', (_event, payload) =>
  getCloudChatService().initializeMemoryWiki(payload),
);

ipcMain.handle('chat:billing:summary', (_event, payload) =>
  getCloudChatService().getBillingSummary(payload),
);

ipcMain.handle('chat:billing:agent-daily', (_event, payload) =>
  getCloudChatService().getAgentDailyBilling(payload),
);

ipcMain.handle('chat:memory:compile:status', (_event, payload) =>
  getCloudChatService().getMemoryCompileStatus(payload),
);

ipcMain.handle('chat:memory:compile:retry', (_event, payload) =>
  getCloudChatService().retryMemoryCompile(payload),
);

ipcMain.handle('chat:thinking:list', (_event, payload) =>
  getCloudChatService().listThinkingProcesses(payload),
);

ipcMain.handle('chat:thinking:by-message', (_event, payload) =>
  getCloudChatService().getThinkingByMessage(payload),
);

ipcMain.handle('chat:share:create', (_event, payload) =>
  getCloudChatService().createShare(payload),
);

ipcMain.handle('chat:share:list', (_event, payload) =>
  getCloudChatService().listShares(payload),
);

ipcMain.handle('chat:share:detail', (_event, payload) =>
  getCloudChatService().getShareDetail(payload),
);

ipcMain.handle('chat:share:continue', (_event, payload) =>
  getCloudChatService().continueShare(payload),
);

ipcMain.handle('chat:share:revoke', (_event, payload) =>
  getCloudChatService().revokeShare(payload),
);

ipcMain.handle('chat:access:check', (_event, payload) =>
  getCloudChatService().checkAccess(payload),
);

ipcMain.handle('chat:access:spectator:update', (_event, payload) =>
  getCloudChatService().updateSpectatorConfig(payload),
);

ipcMain.handle('chat:access:conversation-auth:create', (_event, payload) =>
  getCloudChatService().createConversationAuth(payload),
);

ipcMain.handle('chat:access:conversation-auth:detail', (_event, payload) =>
  getCloudChatService().getConversationAuthDetail(payload),
);

ipcMain.handle('chat:access:conversation-auth-members:update', (_event, payload) =>
  getCloudChatService().updateConversationAuthMembers(payload),
);

ipcMain.handle('chat:access:auth-base:list', (_event, payload) =>
  getCloudChatService().listAuthBase(payload),
);

ipcMain.handle('chat:access:share:update', (_event, payload) =>
  getCloudChatService().updateShareAccess(payload),
);

ipcMain.handle('chat:access:share-auth:create', (_event, payload) =>
  getCloudChatService().createShareAuth(payload),
);

ipcMain.handle('chat:access:share-auth:detail', (_event, payload) =>
  getCloudChatService().getShareAuthDetail(payload),
);

ipcMain.handle('chat:access:share-auth-members:update', (_event, payload) =>
  getCloudChatService().updateShareAuthMembers(payload),
);

ipcMain.handle('chat:automation:sessions:list', (_event, payload) =>
  getCloudChatService().listAgentCronSessions(payload),
);

ipcMain.handle('chat:automation:sessions:detail', (_event, payload) =>
  getCloudChatService().getAgentCronSessionDetail(payload),
);

ipcMain.handle('chat:automation:sessions:pause', (_event, payload) =>
  getCloudChatService().pauseAgentCronSession(payload),
);

ipcMain.handle('chat:automation:sessions:resume', (_event, payload) =>
  getCloudChatService().resumeAgentCronSession(payload),
);

ipcMain.handle('chat:automation:sessions:complete', (_event, payload) =>
  getCloudChatService().completeAgentCronSession(payload),
);

ipcMain.handle('chat:automation:sessions:recover-open-runs', (_event, payload) =>
  getCloudChatService().recoverAgentCronSessionOpenRuns(payload),
);

ipcMain.handle('chat:automation:runs:list', (_event, payload) =>
  getCloudChatService().listAgentCronRuns(payload),
);

ipcMain.handle('chat:automation:sessions:create', (_event, payload) =>
  getCloudChatService().createAgentCronSession(payload),
);

ipcMain.handle('chat:automation:sessions:update', (_event, payload) =>
  getCloudChatService().updateAgentCronSession(payload),
);

ipcMain.handle('chat:roundtable:inject', (_event, payload) =>
  getCloudChatService().injectRoundTableTurn(payload),
);

ipcMain.handle('chat:roundtable:abort', (_event, payload) =>
  getCloudChatService().abortRoundTableTurn(payload),
);

ipcMain.handle('chat:roundtable:transcript', (_event, payload) =>
  getCloudChatService().getRoundTableTranscript(payload),
);

ipcMain.handle('chat:agent-memory:patch:update-status', (_event, payload) =>
  getCloudChatService().updateAgentMemoryPatchStatus(payload),
);

ipcMain.handle('chat:trace:message-detail', (_event, payload) =>
  getCloudChatService().getMessageTrace(payload),
);

ipcMain.handle('chat:trace:conversation-detail', (_event, payload) =>
  getCloudChatService().getConversationTrace(payload),
);

ipcMain.handle('chat:tool-calls:detail', (_event, payload) =>
  getCloudChatService().getToolCallDetail(payload),
);

ipcMain.handle('chat:tool-calls:list', (_event, payload) =>
  getCloudChatService().listToolCalls(payload),
);

ipcMain.handle('chat:tool-calls:statistics:conversation', (_event, payload) =>
  getCloudChatService().getConversationToolCallStatistics(payload),
);

ipcMain.handle('chat:tool-calls:recent', (_event, payload) =>
  getCloudChatService().getRecentToolCalls(payload),
);

ipcMain.handle('chat:tool-calls:message', (_event, payload) =>
  getCloudChatService().getMessageToolCalls(payload),
);

ipcMain.handle('chat:statistics:overview', (_event, payload) =>
  getCloudChatService().getChatStatisticsOverview(payload),
);

ipcMain.handle('chat:statistics:trends', (_event, payload) =>
  getCloudChatService().getChatStatisticsTrends(payload),
);

ipcMain.handle('chat:statistics:tools-ranking', (_event, payload) =>
  getCloudChatService().getChatStatisticsToolRanking(payload),
);

ipcMain.handle('chat:statistics:users-ranking', (_event, payload) =>
  getCloudChatService().getChatStatisticsUserRanking(payload),
);

ipcMain.handle('chat:statistics:realtime', (_event, payload) =>
  getCloudChatService().getChatStatisticsRealtime(payload),
);

ipcMain.handle('chat:statistics:export-cloud', (_event, payload) =>
  getCloudChatService().exportChatStatistics(payload),
);

ipcMain.handle('chat:statistics:export-local', (_event, payload) =>
  saveChatStatisticsSnapshot(payload),
);

ipcMain.handle('chat:studio:scene-current', () =>
  getCloudChatService().getOpenClawCurrentScene(),
);

ipcMain.handle('chat:studio:scene-events', (_event, payload) =>
  getCloudChatService().getOpenClawSceneEvents(payload),
);

ipcMain.handle('chat:studio:agent-channels', (_event, payload) =>
  getCloudChatService().listOpenClawAgentChannels(payload),
);

ipcMain.handle('chat:studio:channel-sessions', (_event, payload) =>
  getCloudChatService().listOpenClawAgentChannelSessions(payload),
);

ipcMain.handle('chat:studio:agent-chat-enter', (_event, payload) =>
  getCloudChatService().enterOpenClawAgentChat(payload),
);

ipcMain.handle('chat:studio:channel-session-enter', (_event, payload) =>
  getCloudChatService().enterOpenClawAgentChannelSession(payload),
);

ipcMain.handle('chat:openclaw-governance:catalog', () =>
  getCloudChatService().getOpenClawGovernanceCatalog(),
);

ipcMain.handle('chat:openclaw-governance:identity-profiles', () =>
  getCloudChatService().listOpenClawIdentityProfiles(),
);

ipcMain.handle('chat:openclaw-governance:role-postures', () =>
  getCloudChatService().listOpenClawRolePostures(),
);

ipcMain.handle('chat:openclaw-governance:unified-service-refs', () =>
  getCloudChatService().listOpenClawUnifiedServiceRefs(),
);

ipcMain.handle('chat:openclaw-governance:capability-profiles', () =>
  getCloudChatService().listOpenClawCapabilityProfiles(),
);

ipcMain.handle('chat:openclaw-governance:memory-packs', () =>
  getCloudChatService().listOpenClawMemoryPacks(),
);

ipcMain.handle('chat:openclaw-governance:seed-memory-packs', () =>
  getCloudChatService().listOpenClawSeedMemoryPacks(),
);

ipcMain.handle('chat:openclaw-governance:memory-binding-policies', () =>
  getCloudChatService().listOpenClawMemoryBindingPolicies(),
);

ipcMain.handle('chat:openclaw-governance:memory-workspaces', () =>
  getCloudChatService().listOpenClawMemoryWorkspaces(),
);

ipcMain.handle('chat:openclaw-governance:memory-snapshots', () =>
  getCloudChatService().listOpenClawMemorySnapshots(),
);

ipcMain.handle('chat:openclaw-governance:memory-training-runs', () =>
  getCloudChatService().listOpenClawMemoryTrainingRuns(),
);

ipcMain.handle('chat:openclaw-governance:training-scorecards', () =>
  getCloudChatService().listOpenClawTrainingScorecards(),
);

ipcMain.handle('chat:openclaw-governance:learning-samples', () =>
  getCloudChatService().listOpenClawLearningSamples(),
);

ipcMain.handle('chat:openclaw-governance:memory-candidates', () =>
  getCloudChatService().listOpenClawMemoryCandidates(),
);

ipcMain.handle('chat:openclaw-governance:zeus-backflow-exports', () =>
  getCloudChatService().listOpenClawZeusBackflowExports(),
);

ipcMain.handle('chat:openclaw-governance:model-policies', () =>
  getCloudChatService().listOpenClawModelPolicies(),
);

ipcMain.handle('chat:openclaw-governance:credential-profiles', () =>
  getCloudChatService().listOpenClawCredentialProfiles(),
);

ipcMain.handle('chat:openclaw-governance:eval-suites', () =>
  getCloudChatService().listOpenClawEvalSuites(),
);

ipcMain.handle('chat:openclaw-governance:simulation-evals', () =>
  getCloudChatService().listOpenClawSimulationEvals(),
);

ipcMain.handle('chat:openclaw-governance:certifications', () =>
  getCloudChatService().listOpenClawCertifications(),
);

ipcMain.handle('chat:openclaw-governance:agent-releases', () =>
  getCloudChatService().listOpenClawAgentReleases(),
);

ipcMain.handle('chat:openclaw-governance:release-channels', () =>
  getCloudChatService().listOpenClawReleaseChannels(),
);

ipcMain.handle('chat:openclaw-governance:on-duty-policies', () =>
  getCloudChatService().listOpenClawOnDutyPolicies(),
);

ipcMain.handle('chat:openclaw-governance:schedule-policies', () =>
  getCloudChatService().listOpenClawSchedulePolicies(),
);

ipcMain.handle('chat:openclaw-governance:alert-policies', () =>
  getCloudChatService().listOpenClawAlertPolicies(),
);

ipcMain.handle('chat:openclaw-governance:alert-incidents', () =>
  getCloudChatService().listOpenClawAlertIncidents(),
);

ipcMain.handle('chat:openclaw-governance:remediation-policies', () =>
  getCloudChatService().listOpenClawRemediationPolicies(),
);

ipcMain.handle('chat:openclaw-governance:remediation-actions', () =>
  getCloudChatService().listOpenClawRemediationActions(),
);

ipcMain.handle('chat:openclaw-governance:human-takeovers', () =>
  getCloudChatService().listOpenClawHumanTakeovers(),
);

ipcMain.handle('chat:openclaw-governance:upgrade-jobs', () =>
  getCloudChatService().listOpenClawUpgradeJobs(),
);

ipcMain.handle('chat:openclaw-governance:effective-agent-config', (_event, payload) =>
  getCloudChatService().resolveOpenClawEffectiveAgentConfig(payload),
);

ipcMain.handle('chat:openclaw-governance:conversation-effective-config', (_event, payload) =>
  getCloudChatService().resolveOpenClawConversationEffectiveConfig(payload),
);

ipcMain.handle('chat:client-tool:result', (_event, payload) =>
  getCloudChatService().reportClientToolResult(payload),
);

ipcMain.handle('chat:client-tool:poll', (_event, payload) =>
  getCloudChatService().pollClientToolCalls(payload),
);

ipcMain.handle('locale:set', (_event, payload) => {
  sessionStore.setLocale(payload.locale);
  // 持久化到 ~/.zeusos/settings.json，重启恢复（locale 也是用户设置，与 appearance/appMode 一起收口）
  settingsStore.merge({ locale: payload.locale });
  return sessionStore.getSession();
});

function createPermissionGrant({ toolCallId, granted }) {
  return {
    grantId: randomUUID(),
    toolCallId,
    granted,
    duration: granted ? 'once' : 'denied',
    scope: 'client_session',
    decidedAt: new Date().toISOString(),
  };
}

ipcMain.handle('permission:approve', (_event, payload) =>
  createPermissionGrant({ toolCallId: payload.toolCallId, granted: true }),
);

ipcMain.handle('permission:deny', (_event, payload) =>
  createPermissionGrant({ toolCallId: payload.toolCallId, granted: false }),
);

ipcMain.handle('core:health', (_event, payload) => {
  const capability = capabilityRegistry.findCapability('local.health');
  if (!capability) {
    return {
      toolCallId: payload.toolCallId,
      status: 'failed',
      outputPreview: {
        status: 'capability_not_registered',
        capabilityId: 'local.health',
      },
      evidence: {
        evidenceId: randomUUID(),
        toolCallId: payload.toolCallId,
        summary:
          sessionStore.getSession().locale === 'zh-CN'
            ? 'local.health 能力未注册。'
            : 'Local health capability is not registered.',
        locale: sessionStore.getSession().locale,
        returnedToCloud: false,
        dataLevel: 'D0_public',
        redactions: [],
        artifactRefs: [],
      },
      completedAt: new Date().toISOString(),
    };
  }

  sessionStore.setPendingReviewCount(0);
  return runHealthStub({ workspaceRoot: resourcesRoot, toolCallId: payload.toolCallId, locale: sessionStore.getSession().locale });
});

let localToolHost;

app.whenReady().then(async () => {
  setDockIcon();

  // 统一走 ~/.zeusos（见顶部 zeusHome）；skillStore / shellProvider / localToolHost
  // 及其下游 shell-artifacts、shell-permission-rules 全部继承这个根。
  const userDataPath = zeusHome;
  const disableLocalSkill = process.env.ZEUS_ATLAS_DISABLE_LOCAL_SKILL === '1';
  skillStore = disableLocalSkill ? null : createSkillStore({ userDataPath });

  // Shell 环境快照：启动时 source 用户 .zshrc/.bashrc 一次,捕获 PATH/env →
  // 后续 shell 命令 source 快照而非每次 spawn login shell（对齐 Claude Code）。
  await createShellEnvSnapshot();

  // 端云本地工具调度统一走 SSE → 渲染层 → IPC,主进程不再持有 WS 链路或自动审批器。
  // dev-mode 自动放行的决策由渲染层基于 bootstrap.runtime.isDevMode 做出,
  // permission-review 看到 localApproval.granted=true 即按 allow 处理。
  const shellProvider = createLocalShellProvider({
    workspaceRoot: resourcesRoot,
    userDataPath,
  });

  localToolHost = createLocalToolHost({
    workspaceRoot: resourcesRoot,
    userDataPath,
    sessionStore,
    runHealthStub,
    mcpRegistry,
    shellProvider,
    extraProviders: skillStore ? [createLocalSkillProvider({ skillStore })] : [],
  });

  ipcMain.handle('client-tool:execute', (_event, payload) => {
    if (!localToolHost) {
      throw new Error('local_tool_host_not_ready');
    }
    return localToolHost.execute(
      { call: payload?.call },
      {
        localApproval: payload?.grant,
        source: 'renderer_client_tool_polling',
      },
    );
  });
  ipcMain.handle('shell:tasks:list', () => localToolHost.listShellTasks());
  ipcMain.handle('shell:tasks:stop-active', () => localToolHost.stopActiveShellTask());
  ipcMain.handle('shell:tasks:stop', (_event, payload) => localToolHost.stopShellTask(payload?.taskId || payload?.toolCallId));
  ipcMain.handle('shell:permissions:list', () => localToolHost.permissionReview.listShellRules());
  ipcMain.handle('shell:permissions:add', (_event, payload) => localToolHost.permissionReview.addShellRule(payload));
  ipcMain.handle('staff:search', async (_event, { query }) => {
    try {
      const result = await getCloudChatService().searchStaff({ query: String(query || '') });
      return result?.data ?? [];
    } catch { return []; }
  });
  ipcMain.handle('staff:get-by-ids', async (_event, { workIds }) => {
    try {
      const result = await getCloudChatService().getStaffByIds({ workIds: String(workIds || '') });
      return result?.data ?? [];
    } catch { return []; }
  });
  ipcMain.handle('skills:list', () => skillStore?.listSkills() ?? []);
  ipcMain.handle('skills:refresh', () => { skillStore?.refresh(); return skillStore?.listSkills() ?? []; });
  ipcMain.handle('skills:upload', (_event, { zipBase64 }) => {
    if (!skillStore) throw new Error('skill_store_not_available');
    return skillStore.installSkillFromZip(Buffer.from(zipBase64, 'base64'));
  });
  ipcMain.handle('skills:enable', (_event, { skillId }) => {
    if (!skillStore) throw new Error('skill_store_not_available');
    return skillStore.enableSkill(skillId);
  });
  ipcMain.handle('skills:disable', (_event, { skillId }) => {
    if (!skillStore) throw new Error('skill_store_not_available');
    return skillStore.disableSkill(skillId);
  });

  createWindow();

  // OTA 自动更新（仅打包态生效）
  const mainWin = BrowserWindow.getAllWindows()[0];
  registerUpdaterIPC();
  initAutoUpdater(mainWin);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
