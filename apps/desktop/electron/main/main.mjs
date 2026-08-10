import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain as electronIpcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, screen, session, shell, systemPreferences, Tray, webContents } from 'electron';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

/** 内嵌 Browser 持久分区（与 renderer BrowserView 一致）。 */
const PEER_BROWSER_PARTITION = 'persist:peer-browser';

const execFileAsync = promisify(execFile);
import { createCapabilityRegistry } from './capability-registry.mjs';
import { loadLocalEnv } from './env-loader.mjs';
import { readProjectIndex } from './project-index.mjs';
import { createSessionStore, resolveLocalAccessLevel } from './session-store.mjs';
import { createLocalToolHost } from './runtime-gateway/local-tool-host.mjs';
import { createBrowserPanelRevealCoordinator } from './runtime-gateway/browser-panel-reveal-coordinator.mjs';
import {
  getActiveBrowserEntry,
  registerBrowserWebContents,
  unregisterBrowserWebContents,
  getActiveWebContentsId,
} from './runtime-gateway/browser-control-registry.mjs';
import { listChromeBrowserSources } from './session-import/chrome-profiles.mjs';
import {
  buildSessionImportPreflight,
  openFullDiskAccessSettings,
  resolveFullDiskAccessDragTarget,
} from './session-import/import-permission-preflight.mjs';
import { buildStartupOsPermissions } from './startup-os-permissions.mjs';
import { createFullDiskAccessDragFloatController } from './full-disk-access-drag-float.mjs';
import {
  loadCookiesForSites,
  redactLoadedCookies,
  scanProfileSites,
} from './session-import/import-cookies.mjs';
import { applyCookiesToSession } from './session-import/apply-cookies.mjs';
import { createPasswordVaultStore } from './password-vault-store.mjs';
import { buildAppMenu } from './app-menu.mjs';
import { createLocalShellProvider } from './runtime-gateway/local-shell-provider.mjs';
import { createLocalSkillProvider } from './runtime-gateway/local-skill-provider.mjs';
import { createSkillStore } from './skill-store.mjs';
import { createSkillHubApiClient } from './skillhub-api-client.mjs';
import { createSkillHubMarketplaceStore } from './skillhub-marketplace-store.mjs';
import { createSkillHubVerifiedInstaller } from './skillhub-verified-installer.mjs';
import { createSkillHubMarketplaceService } from './skillhub-marketplace-service.mjs';
import { createShellEnvSnapshot } from './runtime-gateway/shell-env-snapshot.mjs';
import { createSettingsStore } from './settings-store.mjs';
import { createShortcutService } from './shortcut-service.mjs';
import { createAppshotService } from './appshot-service.mjs';
import { buildAppshotPermissionPreflight, openScreenRecordingSettings } from './appshot-permission-preflight.mjs';
import { deliverAppshot } from './appshot-delivery.mjs';
import {
  createQuickChatWindowController,
  DEFAULT_SIZE as QUICK_CHAT_SIZE,
} from './quick-chat-window.mjs';
import { getMainWindowWebContents, getOAuthWindowWebContents } from './window-routing.mjs';
import { createMcpRegistry } from './mcp-registry.mjs';
import { createMcpCredentialResolver, createMcpCredentialStore } from './mcp-credential-store.mjs';
import { disconnectMcp, finishMcpOAuth, getMcpPrompt, probeMcpConnection, readMcpResource, startMcpOAuth, testMcpConnection } from './mcp-client.mjs';
import { createLlmConfigStore } from './llm-config-store.mjs';
import { collectUsageStats } from './usage-stats.mjs';
import { collectCacheHitRateMetrics } from './cache-hit-rate.mjs';
import { collectUsageDaily } from './usage-daily.mjs';
import { collectUsageDay } from './usage-day.mjs';
import { listChannelDescriptors, listServiceTemplates, resolveChannel } from './provider-channels.mjs';
import { fetchWithConnectionRecovery } from './provider-transports/recovering-fetch.mjs';
import { createHostRestarter } from './host-restart.mjs';
import { createHostRestartApplicationService } from './host-restart-application-service.mjs';
import { createMcpApplicationService } from './mcp-application-service.mjs';
import { createPendingTaskApplicationService } from './pending-task-application-service.mjs';
import { createProviderConfigurationApplicationService } from './provider-configuration-application-service.mjs';
import { createProviderAccessApplicationService } from './provider-access-application-service.mjs';
import { resolveDockIconPaths } from './dock-icon-paths.mjs';
import { createTrayController, TRAY_RECENT_EXPANDED_LIMIT, TRAY_RECENT_LIMIT } from './tray-controller.mjs';
import { clearPendingTask, peekPendingTask, readAndClearPendingTask, writePendingTask } from './pending-task-store.mjs';
import { buildRuntimeTools, createLlmChatService } from './llm-chat-service.mjs';
import {
  createAutomationStore,
  createGoalPlanStore,
  createGoalRunner,
  decideIntakeConvergence,
  exportBundle,
  getDataHome,
  goalPlanIsSelfDriven,
  importBundle,
  migrateFromLegacy,
  removeConversationToolArtifacts,
  serializeAcceptedGoalRunnerHandoff,
  shouldAutoStartAcceptedGoalRunner,
  shouldAutoStartAcceptedGoalRunnerFromChange,
  shouldResumeGoalRunnerAfterUserDecision,
  shouldRecoverAcceptedGoalRunnerOnConversationOpen,
} from '@peer-agent/runtime-node';
import {
  createContextAccountingCompactionPipeline,
  createRestoredObservedContextAccountingSnapshot,
  createUnknownContextAccountingSnapshot,
  projectConversationHistory,
  reprojectContextAccountingWindow,
} from '@peer-agent/runtime-core';
import { contextAccountingModelKey } from '@peer-agent/protocol';
import {
  countAnthropicCanonicalRequest,
  countGeminiCanonicalRequest,
} from './provider-adapters/context-count-adapter.mjs';
import { buildSystemContext, renderSystemContext } from './llm-prompts.mjs';
import { createContextBaselineRecorder } from './prompt/context-baseline-recorder.mjs';
import { createPromptSnapshotStore } from './prompt/prompt-snapshot-store.mjs';
import { createConversationStore } from './conversation-store.mjs';
import { resolveConversationModelProviderId } from './conversation-model-binding.mjs';
import { bindExternalGoalPlanChanges } from './goal-plan-change-bridge.mjs';
import { createTaskNotificationBroker } from './task-notification-broker.mjs';
import { createAutomationRuntimeOwner } from './automation-runtime-owner.mjs';
import { createAutomationRunner } from './automation-runner.mjs';
import { createAutomationOutcomeController } from './automation-outcome-controller.mjs';
import { createAutomationWorktreeAdapter } from './automation-worktree-adapter.mjs';
import {
  buildGoalRunnerStreamStartedPayload,
  createGoalRunnerAssistantPlaceholder,
} from './goal-runner-message-persistence.mjs';
import { fetchProviderSubscriptionQuota } from './subscription-quota.mjs';
import {
  applyGoalMessageRoute,
  consumesRequestedUserInput,
  routeGoalMessage,
} from './goal-message-router.mjs';
import { createLocalGoalProvider } from './runtime-gateway/local-goal-provider.mjs';
import {
  buildPersistedCompactedMessages,
  persistCompactedConversation,
} from './conversation-compaction-persistence.mjs';
import { runCompactionCheck } from './chat-runtime/compaction-coordinator.mjs';
import { applyMicrocompaction } from './chat-runtime/compaction-coordinator.mjs';
import { getCompaction } from './chat-runtime/compaction-registry.mjs';
import { resolveProviderCredential, refreshExpiredOAuthProviders } from './provider-credential-resolver.mjs';
import {
  bindDesktopAppLifecycle,
  createDesktopCompositionRoot,
} from './desktop-composition-root.mjs';
import { createCatalogIpcMain } from './ipc/catalog-ipc-main.mjs';
import { createBrowserIpcRegistrations } from './ipc/register-browser-ipc.mjs';
import { createChatIpcRegistrations } from './ipc/register-chat-ipc.mjs';
import { createConversationSessionIpcRegistrations } from './ipc/register-conversation-session-ipc.mjs';
import { createDataIpcRegistrations } from './ipc/register-data-ipc.mjs';
import { createDesktopIpcRegistrations } from './ipc/register-desktop-ipc.mjs';
import { createGoalIpcRegistrations } from './ipc/register-goal-ipc.mjs';
import { createAutomationIpcRegistrations } from './ipc/register-automation-ipc.mjs';
import { createTaskOverviewIpcRegistrations } from './ipc/register-task-overview-ipc.mjs';
import { createTaskOverviewAggregator } from './task-overview-aggregator.mjs';
import { createAutomationApplicationService } from './automation-application-service.mjs';
import { createAutomationChatProposalService } from './automation-chat-proposal-service.mjs';
import { createHostIpcRegistrations } from './ipc/register-host-ipc.mjs';
import { createMcpIpcRegistrations } from './ipc/register-mcp-ipc.mjs';
import { createFileAccessIpcRegistrations } from './ipc/register-file-access-ipc.mjs';
import { createPendingTaskIpcRegistrations } from './ipc/register-pending-task-ipc.mjs';
import { createPasswordVaultIpcRegistrations } from './ipc/register-password-vault-ipc.mjs';
import { createProviderConfigurationIpcRegistrations } from './ipc/register-provider-configuration-ipc.mjs';
import { createProviderAccessIpcRegistrations } from './ipc/register-provider-access-ipc.mjs';
import { createRuntimeHostIpcRegistrations } from './ipc/register-runtime-host-ipc.mjs';
import { createWorkspaceIpcRegistrations } from './ipc/register-workspace-ipc.mjs';
import { createSettingsIpcRegistrations } from './ipc/register-settings-ipc.mjs';
import { createSkillsIpcRegistrations } from './ipc/register-skills-ipc.mjs';
import { createSkillMarketplaceService } from './skill-marketplace-service.mjs';
import { registerIpcOwners } from './ipc/register-all.mjs';
import { createTrustedWindowRegistry } from './ipc/trusted-window-registry.mjs';
import {
  createPermissionGrantService,
  createSettingsApplicationService,
} from './settings-application-service.mjs';
import { createBrowserCoreApplicationService } from './browser-core-application-service.mjs';
import { createBrowserFdaDragApplicationService } from './browser-fda-drag-application-service.mjs';
import { createBrowserSessionImportApplicationService } from './browser-session-import-application-service.mjs';
import { createChatStreamApplicationService } from './chat-stream-application-service.mjs';
import { createConversationApplicationService } from './conversation-application-service.mjs';
import { createConversationSessionApplicationService } from './conversation-session-application-service.mjs';
import { createFileAccessApplicationService } from './file-access-application-service.mjs';
import { createGoalApplicationService } from './goal-application-service.mjs';
import { createOpenPathApplicationService } from './open-path-application-service.mjs';
import { createPasswordVaultFillApplicationService } from './password-vault-fill-application-service.mjs';
import { createWorkspaceApplicationService } from './workspace-application-service.mjs';
import {
  initAutoUpdater,
  stopAutoUpdater,
  getUpdaterStatus,
  setChannelPreference,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  openInstaller,
  openReleasePage,
} from './auto-updater.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trustedWindowRegistry = createTrustedWindowRegistry({
  openExternal: (url) => shell.openExternal(url),
});
const ipcMain = createCatalogIpcMain({
  ipcMain: electronIpcMain,
  authorize: trustedWindowRegistry.authorize,
});

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
const resourcesRoot = isPackaged ? process.resourcesPath : workspaceRoot;
const loadedEnvKeys = isPackaged ? [] : loadLocalEnv({ workspaceRoot });
console.log('[env-diag] workspaceRoot=', workspaceRoot ?? '(packaged)');
console.log('[env-diag] resourcesRoot=', resourcesRoot);
console.log('[env-diag] loadedEnvKeys=', loadedEnvKeys);
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const availableLocales = ['zh-CN', 'en-US'];
const {
  fallback: desktopIconPath,
  light: macDockIconPath,
  dark: macDarkDockIconPath,
} = resolveDockIconPaths({ isPackaged, workspaceRoot, resourcesRoot });

function getDesktopIconPath() {
  return desktopIconPath && existsSync(desktopIconPath) ? desktopIconPath : undefined;
}

function applyNativeThemeSource(appearance = settingsStore.getAll().appearance) {
  // Keep Electron/nativeTheme (and thus vibrancy materials) aligned with app appearance.
  // Without this, Quick Chat vibrancy can stay system-light while renderer is dark (or vice versa).
  const mode = appearance?.mode;
  if (mode === 'dark') nativeTheme.themeSource = 'dark';
  else if (mode === 'light') nativeTheme.themeSource = 'light';
  else nativeTheme.themeSource = 'system';
}

function setDockIcon(appearance = settingsStore.getAll().appearance) {
  // app.dock.setIcon renders a PNG as-is in both development and packaged apps,
  // so the shipped theme variants already include their macOS alpha mask.
  applyNativeThemeSource(appearance);
  const followsSystem = appearance?.mode === 'system' || appearance?.mode == null;
  const useDarkIcon = appearance?.mode === 'dark'
    || (followsSystem && nativeTheme.shouldUseDarkColors);
  const preferredIconPath = useDarkIcon ? macDarkDockIconPath : macDockIconPath;
  let iconPath = getDesktopIconPath();
  if (macDockIconPath && existsSync(macDockIconPath)) iconPath = macDockIconPath;
  if (preferredIconPath && existsSync(preferredIconPath)) iconPath = preferredIconPath;
  if (process.platform === 'darwin' && iconPath && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }
}

const dataHome = getDataHome();
{
  let legacyUserData = null;
  try {
    legacyUserData = app.getPath('userData');
  } catch {
    /* app ready 前取不到 userData */
  }
  migrateFromLegacy(legacyUserData);
}

const settingsStore = createSettingsStore();
const initialSettings = settingsStore.getAll();

const capabilityRegistry = createCapabilityRegistry({ workspaceRoot: resourcesRoot });
const sessionStore = createSessionStore({
  workspaceRoot: resourcesRoot,
  userDataPath: dataHome,
  listCapabilities: capabilityRegistry.listCapabilities,
  preferredLocale: initialSettings.locale ?? process.env.PEER_AGENT_LOCALE,
  preferredAccessLevel: initialSettings.localAccessLevel,
});

// SkillStore must exist before createLlmChatService so chat-time tool projection
// can read enabled skills. Marketplace services remain lazy in startLocalRuntime.
const disableLocalSkill = process.env.PEER_AGENT_DISABLE_LOCAL_SKILL === '1';
const skillSourceRoots = [path.join(os.homedir(), '.agents', 'skills')];
let skillStore = disableLocalSkill
  ? null
  : createSkillStore({
      userDataPath: dataHome,
      sourceRoots: skillSourceRoots,
      workspacePath: initialSettings.activeWorkspace || null,
    });
let skillMarketplaceService;
let skillHubMarketplaceService;

const mcpRegistry = createMcpRegistry();
const mcpCredentialStore = createMcpCredentialStore();
const passwordVaultStore = createPasswordVaultStore();
const baseMcpCredentialResolver = createMcpCredentialResolver(mcpCredentialStore);
const mcpCredentialResolver = async (auth, server) => {
  const injection = await baseMcpCredentialResolver(auth, server);
  if (injection?.authProviderConfig) {
    injection.authProviderConfig.openAuthorizationUrl = (url) => shell.openExternal(String(url));
  }
  return injection;
};
const MCP_OAUTH_CALLBACK_PORT = 33418;
const MCP_OAUTH_CALLBACK_PATH = '/mcp/oauth/callback';
const MCP_OAUTH_CALLBACK_URL = `http://127.0.0.1:${MCP_OAUTH_CALLBACK_PORT}${MCP_OAUTH_CALLBACK_PATH}`;
const MCP_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
let activeMcpOAuthCallback = null;

function closeMcpOAuthCallback() {
  if (activeMcpOAuthCallback?.server) {
    try { activeMcpOAuthCallback.server.close(); } catch {}
  }
  if (activeMcpOAuthCallback?.timer) clearTimeout(activeMcpOAuthCallback.timer);
  activeMcpOAuthCallback = null;
}

function waitForMcpOAuthCallback(expectedState) {
  closeMcpOAuthCallback();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const callbackUrl = new URL(req.url ?? '/', MCP_OAUTH_CALLBACK_URL);
        if (callbackUrl.pathname !== MCP_OAUTH_CALLBACK_PATH) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        const state = callbackUrl.searchParams.get('state') ?? '';
        const code = callbackUrl.searchParams.get('code') ?? '';
        const error = callbackUrl.searchParams.get('error') ?? '';
        if (expectedState && state && state !== expectedState) throw new Error('MCP OAuth state mismatch.');
        if (error) throw new Error(`MCP OAuth failed: ${error}`);
        if (!code) throw new Error('MCP OAuth callback missing authorization code.');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Peer Agent MCP OAuth</title><p>授权已完成，可以回到 Peer Agent。</p>');
        resolve(code);
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Peer Agent MCP OAuth</title><p>授权失败，请回到 Peer Agent 重试。</p>');
        reject(error);
      } finally {
        closeMcpOAuthCallback();
      }
    });
    server.once('error', (error) => {
      closeMcpOAuthCallback();
      reject(error);
    });
    server.listen(MCP_OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
      const timer = setTimeout(() => {
        closeMcpOAuthCallback();
        reject(new Error('MCP OAuth authorization timed out.'));
      }, MCP_OAUTH_CALLBACK_TIMEOUT_MS);
      activeMcpOAuthCallback = { server, timer };
    });
  });
}

const llmConfigStore = createLlmConfigStore();
const conversationStore = createConversationStore();
const stopConversationChangeSubscription = conversationStore.subscribeChanges((event) => {
  broadcastToAllWindows('taskOverview:changed', { reason: 'conversations:changed' });
  if (event.writerPid === process.pid) return;

  const workspacePath = typeof event.workspacePath === 'string' ? event.workspacePath : null;
  if (workspacePath && existsSync(workspacePath)) {
    broadcastToAllWindows('workspaces:changed', { workspacePath });
  }

  broadcastToAllWindows('conversations:changed', event);
  trayController?.scheduleRefresh?.();
});

const automationStore = createAutomationStore({
  onChange: (payload) => {
    broadcastToAllWindows('automations:changed', payload);
    broadcastToAllWindows('taskOverview:changed', { reason: 'automations:changed' });
  },
});
let automationRuntimeOwner = null;
let automationRunner = null;
const automationApplicationService = createAutomationApplicationService({
  store: automationStore,
  getRunner: () => automationRunner,
  getScheduler: () => automationRuntimeOwner?.scheduler ?? null,
});
const automationProposalService = createAutomationChatProposalService({
  getContext: (conversationId) => (
    conversationStore.getConversation(conversationId)?.automationCreateContext ?? null
  ),
  saveContext: (conversationId, context) => (
    conversationStore.updateAutomationCreateContext(conversationId, context)
  ),
  createAutomation: (definition) => automationApplicationService.create(definition),
});

const goalPlanStore = createGoalPlanStore({
  // 任何写路径（IPC 或 AI 工具 local-goal-provider）改动计划后，广播给所有窗口，
  // 让 GoalPlanPanel 实时重拉，无需切换会话/重挂载。详见方案 B。
  // broadcastToAllWindows 是后文的函数声明（已提升），onChange 仅在运行时触发，引用安全。
  onChange: (payload) => {
    broadcastToAllWindows('goalPlans:changed', payload);
    broadcastToAllWindows('taskOverview:changed', { reason: 'goalPlans:changed' });
    try {
      taskNotificationBroker?.handleGoalPlanChanged(payload);
    } catch (err) {
      console.warn('[task-notification] handleGoalPlanChanged failed:', err);
    }
    // goal_create_plan 写盘后立刻 kick Runner，不依赖 intake agent loop 是否成功 sendDone。
    // 旧路径只在 chat:send outcome resolve 后 auto-start；若 handoff 后流未收口，就会永久卡在 0/N。
    queueMicrotask(() => {
      try {
        maybeAutoStartAcceptedGoalFromPlanChange(payload);
      } catch (error) {
        console.error('[main] plan-change auto-start failed:', error?.message || error);
      }
    });
  },
});
let goalRunner = null;
let localToolHost = null;
// TaskOverview 聚合器：组装 goal-plan-store 与 automation-store 的投影快照，
// 供 taskOverview:list IPC 使用（阶段 1，见 peer-2-0-gap-analysis §11）。
const taskOverviewAggregator = createTaskOverviewAggregator({
  goalPlanStore,
  automationStore,
  listConversations: (params) => conversationStore.listConversations(params),
  // localToolHost 在 startLocalRuntime 后才赋值；list 时惰性读取，避免启动环依赖。
  listShellTasks: () => localToolHost?.listShellTasks?.() ?? [],
  // 把 modelProviderId（配置项 UUID）解析成可读提供商/模型名；勿直接展示 id。
  listProviders: () => llmConfigStore.listProviders(),
});
const browserPanelRevealCoordinator = createBrowserPanelRevealCoordinator({
  broadcast: broadcastToAllWindows,
  isBrowserReady: (conversationId) => {
    const entry = getActiveBrowserEntry(conversationId);
    if (!entry?.webContentsId) return false;
    const browserWebContents = webContents.fromId(entry.webContentsId);
    return Boolean(browserWebContents && !browserWebContents.isDestroyed());
  },
});
let taskNotificationBroker = null;
let trayController = null;
let desktopLifecycleBinding = null;
const stopGoalPlanChangeSubscription = bindExternalGoalPlanChanges({
  goalPlanStore,
  broadcast: broadcastToAllWindows,
  getTaskNotificationBroker: () => taskNotificationBroker,
});
const promptSnapshotStore = createPromptSnapshotStore();
const contextBaselineRecorder = createContextBaselineRecorder({
  promptSnapshotStore,
  getWorkspacePath: () => settingsStore.getAll().activeWorkspace || null,
});

function recordProviderBaseline(reason, provider) {
  contextBaselineRecorder.recordProviderBaseline({ reason, provider });
}

function getDefaultProviderView() {
  const providers = llmConfigStore.listProviders();
  return providers.find((provider) => provider.isDefault && provider.apiKeyConfigured)
    || providers.find((provider) => provider.apiKeyConfigured)
    || providers.find((provider) => provider.isDefault)
    || null;
}

function normalizeSystemInstructions(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function recordInstructionBaseline(instructions) {
  contextBaselineRecorder.recordConfiguredInstructionsBaseline({
    reason: 'instruction_change',
    instructions,
    provider: getDefaultProviderView(),
  });
}

function getActiveContextEpochId(conversationId = null) {
  try {
    return promptSnapshotStore.getLatestContextEpoch(conversationId)?.contextEpochId
      ?? promptSnapshotStore.getLatestContextEpoch(null)?.contextEpochId
      ?? null;
  } catch {
    return null;
  }
}

function persistCompactionToConversation({
  conversationId,
  compactResult,
  preservePendingAssistant = false,
  sourceMessages = null,
}) {
  const conv = conversationStore.getConversation(conversationId);
  if (!conv) return null;
  // 默认 0 而非 10：keptMessageCount 缺失时保守保留 0 条，与「真·全量压缩」语义一致，
  // 避免凭空多保留 10 条旧消息。注意下游 buildPersistedCompactedMessages 对 keptCount<=0 已有安全守卫。
  const keptCount = compactResult.notification?.keptMessageCount ?? 0;
  const compactedMessages = buildPersistedCompactedMessages({
    compactedMessages: compactResult.messages,
    sourceMessages: sourceMessages ?? conv.messages,
    keptCount,
    preservePendingAssistant,
  });
  return persistCompactedConversation({
    store: conversationStore,
    conversationId,
    messages: compactedMessages,
  });
}

function continuityContextFromCompactionResult(result) {
  const handoff = result?.messages?.find((message) => message?._compaction)?._compaction;
  if (!handoff) return [];
  return [{
    id: `manual-compact:${Date.now()}`,
    method: handoff.method || result.notification?.method || 'unknown',
    originalMessageCount: handoff.originalMessageCount ?? result.notification?.oldMessageCount ?? 0,
    beforeTokens: handoff.beforeTokens ?? result.notification?.beforeTokens ?? 0,
    afterTokens: handoff.afterTokens ?? result.notification?.afterTokens ?? 0,
    summary: handoff.summary || '',
  }];
}

function desktopContinuityContextFromProjection(projection) {
  const handoff = projection?.continuity;
  if (!handoff) return [];
  return [{
    id: `conversation-compact:${handoff.sourceMessageId}`,
    method: handoff.method,
    originalMessageCount: handoff.originalMessageCount,
    beforeTokens: handoff.beforeTokens,
    afterTokens: handoff.afterTokens,
    summary: handoff.summary,
  }];
}

// 向所有渲染窗口广播一个事件(用于全局活跃流状态等不绑定单一 streamId 的通知)。
function broadcastToAllWindows(channel, payload) {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function getPeerAgentMainWindow() {
  return BrowserWindow.getAllWindows().find((window) => window.__peerAgentMainWindow === true) || null;
}

function isMainAppForegroundForNotifications() {
  if (!app.isReady() || !app.isActive?.()) return false;
  const mainWindow = getPeerAgentMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) return false;
  return true;
}

function openConversationFromTaskNotification(payload = {}) {
  const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : '';
  const workspacePath = typeof payload.workspacePath === 'string' ? payload.workspacePath : '';
  const eventPayload = {
    conversationId,
    workspacePath,
    planId: payload.planId ?? payload.taskId ?? null,
    messageId: typeof payload.messageId === 'string' ? payload.messageId : null,
    attentionVersion: payload.attentionVersion ?? null,
    source: payload.source || 'system-notification',
  };
  const mainWindow = getPeerAgentMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (conversationId) {
      mainWindow.webContents.send('quick-chat:open-conversation', eventPayload);
    }
    return true;
  }
  // 主窗口不存在时先创建，再在 did-finish-load 后发送（简化：创建后立即 send，renderer 会挂 listener）
  createWindow();
  const created = getPeerAgentMainWindow();
  if (created && !created.isDestroyed() && conversationId) {
    created.webContents.once('did-finish-load', () => {
      if (!created.isDestroyed()) {
        created.webContents.send('quick-chat:open-conversation', eventPayload);
      }
    });
    return true;
  }
  return false;
}

function openAutomationRunFromNotification(payload = {}) {
  showOrCreateMainWindow();
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;
  const send = () => window.webContents.send('automations:open-run', {
    automationId: typeof payload.automationId === 'string' ? payload.automationId : '',
    runId: typeof payload.runId === 'string' ? payload.runId : '',
    conversationId: payload.conversationId ?? null,
  });
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', send);
  else send();
}

function showOrCreateMainWindow() {
  const existing = getPeerAgentMainWindow();
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  createWindow();
  return getPeerAgentMainWindow();
}

function sendMainWindowChannel(channel, payload) {
  const existing = getPeerAgentMainWindow();
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    existing.webContents.send(channel, payload);
    return;
  }
  createWindow();
  const created = getPeerAgentMainWindow();
  if (created && !created.isDestroyed()) {
    created.webContents.once('did-finish-load', () => {
      if (!created.isDestroyed()) {
        created.webContents.send(channel, payload);
      }
    });
  }
}

function openTrayNewChat() {
  sendMainWindowChannel('tray:new-chat', { source: 'tray' });
}

function openTrayMore() {
  sendMainWindowChannel('tray:more', { source: 'tray' });
}

async function listTrayRecentConversations({ limit = TRAY_RECENT_LIMIT } = {}) {
  const requested = Math.max(1, Number(limit) || TRAY_RECENT_LIMIT);
  // 允许「更多」展开到 TRAY_RECENT_EXPANDED_LIMIT，不再硬钳在 5。
  const listed = conversationStore.listConversations({
    status: 'active',
    limit: Math.min(requested, TRAY_RECENT_EXPANDED_LIMIT),
  });
  return (Array.isArray(listed) ? listed : []).map((item) => ({
    id: item.id,
    title: item.title,
    workspacePath: item.workspacePath,
    updatedAt: item.updatedAt,
  }));
}

function createAppTrayController() {
  return createTrayController({
    Tray,
    Menu,
    nativeImage,
    app,
    isPackaged,
    workspaceRoot: workspaceRoot || path.join(__dirname, '../../..'),
    resourcesRoot: process.resourcesPath,
    listRecentConversations: listTrayRecentConversations,
    listRecentAutomationRuns: async ({ limit = 3 } = {}) => automationStore.listRuns({ limit })
      .filter((run) => run.receipt?.summary || run.failureReason || run.blockedReason)
      .map((run) => ({
        automationId: run.automationId,
        runId: run.runId,
        automationName: run.snapshot?.name,
        status: run.status,
        summary: run.receipt?.summary || run.failureReason || run.blockedReason,
      })),
    getAutomationRuntime: async () => ({
      globallyPaused: automationStore.getRuntimeState().globallyPaused,
      activeCount: automationStore.listDefinitions({ statuses: ['active'] }).length,
    }),
    handlers: {
      onOpenConversation: (payload) => {
        openConversationFromTaskNotification({
          conversationId: payload?.conversationId,
          workspacePath: payload?.workspacePath,
          source: payload?.source || 'tray-recent',
        });
      },
      onMore: () => openTrayMore(),
      onNewChat: () => openTrayNewChat(),
      onOpenApp: () => {
        showOrCreateMainWindow();
      },
      onOpenAutomations: () => openAutomationRunFromNotification({}),
      onOpenAutomationRun: (target) => openAutomationRunFromNotification(target),
      onToggleAutomations: (paused) => {
        const scheduler = automationRuntimeOwner?.scheduler;
        if (scheduler) scheduler.setGloballyPaused(paused);
        else automationStore.setRuntimeState({ globallyPaused: paused });
      },
      onQuit: () => {
        app.quit();
      },
    },
  });
}

function showTaskSystemNotification({ title, body, onClick }) {
  if (!Notification.isSupported()) return false;
  try {
    const notification = new Notification({
      title: String(title || 'Peer Agent'),
      body: String(body || ''),
      silent: false,
    });
    if (typeof onClick === 'function') {
      notification.on('click', () => {
        try {
          onClick();
        } catch (err) {
          console.warn('[task-notification] click handler failed:', err);
        }
      });
    }
    notification.show();
    return true;
  } catch (err) {
    console.warn('[task-notification] Notification.show failed:', err);
    return false;
  }
}

function getRunnerWebContents() {
  return getMainWindowWebContents(BrowserWindow.getAllWindows());
}

function toDesktopProviderMessages(messages = []) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(Array.isArray(message.toolCalls) && message.toolCalls.length > 0
      ? {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: call.arguments,
          },
        })),
      }
      : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
  }));
}

function buildGoalRunnerMessage(plan, turnNumber) {
  const planLabel = plan?.title || plan?.goal || plan?.planId || 'goal';
  return `Goal Runner tick ${turnNumber} for goal "${planLabel}" (planId=${plan?.planId || 'unknown'}). Continue from the active GoalPlan state.`;
}

function buildGoalRunnerReminder(plan, turnNumber) {
  return {
    id: `goal-runner-${plan?.planId || 'unknown'}-${turnNumber}`,
    title: 'Goal Runner execution contract',
    kind: 'goal-runner',
    scope: 'turn',
    layer: 'L6_MODE_REMINDER',
    content: 'Continue autonomously within the active goal, boundaries, and success criteria. Use the existing tools and permission flow; when a subtask is completed, update it through the goal task evidence path. If you need user input, permission, or evidence is insufficient, stop and explain the blocker instead of pretending completion.',
  };
}

function buildExplorerMessage({ plan, explorer }) {
  const request = explorer?.request || {};
  const targetWorkspacePath =
    typeof plan?.targetWorkspacePath === 'string' && plan.targetWorkspacePath.trim().length > 0
      ? plan.targetWorkspacePath.trim()
      : null;
  // 跨仓提示：当目标要改的代码仓与会话工作区不同（如"知识库驱动代码库"），
  // 显式告知 Explorer 目标仓绝对路径，并声明它有权用绝对路径跨仓检索/读取，
  // 避免 Explorer 因默认 cwd 在会话工作区而误判"读不到目标代码"。
  const targetWorkspaceLine = targetWorkspacePath
    ? `\nTarget code repository (may differ from the current workspace): ${targetWorkspacePath}`
      + `\nYou may search and read files under this absolute path across repositories; do not assume you are limited to the current workspace.`
    : '';
  return `Explorer mission for plan "${plan?.title || plan?.goal || plan?.planId || 'goal'}".
Question: ${request.question || 'Explore missing evidence for the active goal'}
Reason: ${request.reason || 'The Goal Runner needs more evidence before continuing.'}${targetWorkspaceLine}
Scope include: ${(request.scope?.include || []).join(', ') || '(not specified)'}
Scope exclude: ${(request.scope?.exclude || []).join(', ') || '(not specified)'}
Budget maxToolCalls: ${request.budget?.maxToolCalls || 4}`;
}

function buildExplorerReminder(explorer) {
  return {
    id: `goal-explorer-${explorer?.explorerId || 'unknown'}`,
    title: 'Explorer readonly contract',
    kind: 'goal-explorer',
    scope: 'turn',
    layer: 'L6_MODE_REMINDER',
    content: `Profile: readonly_explorer. You are a dynamically created evidence explorer, not a fixed role.
Use only the tools exposed to this explorer context. Do not modify files, do not update the goal plan, and do not claim evidence you did not inspect.
Use only evidenceRefs shown in your tool results; do not invent refs or cite paths as refs.
Return a concise JSON object only with: summary, findings[{claim,evidenceRefs}], evidenceRefs, recommendedNextStep, confidence(low|medium|high).`,
  };
}

function buildExplorerContext({ plan, explorer }) {
  const request = explorer?.request && typeof explorer.request === 'object' ? explorer.request : {};
  return {
    explorerId: explorer?.explorerId,
    planId: plan?.planId || request.planId,
    planTitle: plan?.title || plan?.goal || null,
    request: {
      ...request,
      explorerId: explorer?.explorerId || request.explorerId,
      planId: plan?.planId || request.planId,
    },
  };
}

function collectLeafTaskSummaries(plan) {
  const out = [];
  const stack = Array.isArray(plan?.tasks) ? [...plan.tasks] : [];
  while (stack.length > 0) {
    const task = stack.shift();
    if (!task || typeof task !== 'object') continue;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    if (subtasks.length > 0) {
      for (const child of subtasks) stack.push(child);
      continue;
    }
    out.push({
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      evidenceRefs: Array.isArray(task.evidenceRefs) ? task.evidenceRefs : [],
    });
  }
  return out;
}

function collectExplorerReports(plan) {
  return (Array.isArray(plan?.runner?.explorers) ? plan.runner.explorers : [])
    .filter((run) => run?.status === 'completed' && run.report)
    .map((run) => ({
      explorerId: run.explorerId,
      summary: run.report.summary,
      evidenceRefs: Array.isArray(run.report.evidenceRefs) ? run.report.evidenceRefs : [],
      confidence: run.report.confidence,
    }));
}

function buildVerifierContext({ plan, verifierRunId }) {
  return {
    verifierRunId,
    planId: plan?.planId,
    plan,
    tasks: collectLeafTaskSummaries(plan),
    explorerReports: collectExplorerReports(plan),
  };
}

function buildVerifierMessage({ plan, verifierRunId }) {
  return `Verifier mission for plan "${plan?.title || plan?.goal || plan?.planId || 'goal'}" (verifierRunId=${verifierRunId}).
Review the existing task evidence, success criteria, criterionResults, and explorer reports. Do not modify files or update the plan.
Return JSON only with: passed, failedCriteria[{criterionId,reason,evidenceRefs}], missingEvidence[{taskId,reason}], risks[], evidenceRefs[], recommendedNextAction.`;
}

function buildVerifierReminder(verifierRunId) {
  return {
    id: `goal-verifier-${verifierRunId || 'unknown'}`,
    title: 'Verifier readonly contract',
    kind: 'goal-verifier',
    scope: 'turn',
    layer: 'L6_MODE_REMINDER',
    content: `Profile: readonly_verifier. Use only read-only tools. Do not modify files, do not update the goal plan, and do not create completion evidence.
Return JSON only with: passed, failedCriteria[{criterionId,reason,evidenceRefs}], missingEvidence[{taskId,reason}], risks[], evidenceRefs[], recommendedNextAction.`,
  };
}

function createCollectingWebContents() {
  // 内存收集器：Explorer / Verifier 专用。不转发到真实渲染窗口，避免内部 JSON 出现在聊天。
  const events = [];
  let text = '';
  let terminal = null;
  return {
    send(channel, payload) {
      events.push({ channel, payload });
      if (channel === 'chat:stream:delta' && typeof payload?.content === 'string') {
        text += payload.content;
      }
      if (channel === 'chat:stream:done' || channel === 'chat:stream:error' || channel === 'chat:stream:aborted') {
        terminal = { channel, payload };
      }
    },
    getText() {
      return text;
    },
    getEvents() {
      return events.slice();
    },
    getTerminal() {
      return terminal;
    },
  };
}

function addEvidenceRefs(target, value) {
  if (typeof value === 'string' && value.trim()) {
    target.add(value.trim());
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) target.add(item.trim());
  }
}

function tryParseJsonObject(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectExplorerEvidenceRefs(events) {
  const refs = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.channel !== 'chat:stream:tool-result') continue;
    const payload = event.payload ?? {};
    addEvidenceRefs(refs, payload.evidenceRefs);

    const parsed = tryParseJsonObject(payload.result);
    if (!parsed) continue;
    addEvidenceRefs(refs, parsed.evidenceRefs);
    addEvidenceRefs(refs, parsed.artifactRef);
    addEvidenceRefs(refs, parsed.artifactRefs);
    addEvidenceRefs(refs, parsed.outputPreview?.artifactRef);
    addEvidenceRefs(refs, parsed.outputPreview?.artifactRefs);
    addEvidenceRefs(refs, parsed.outputPreview?.localToolResultRef?.artifactRef);
    addEvidenceRefs(refs, parsed.outputPreview?.localToolResultRef?.artifactRefs);
  }
  return Array.from(refs);
}

function normalizeVerifierIssues(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const reason = typeof item.reason === 'string' && item.reason.trim()
        ? item.reason.trim()
        : '';
      if (!reason) return null;
      return {
        ...(typeof item.taskId === 'string' && item.taskId.trim() ? { taskId: item.taskId.trim() } : {}),
        ...(typeof item.criterionId === 'string' && item.criterionId.trim() ? { criterionId: item.criterionId.trim() } : {}),
        reason,
        evidenceRefs: Array.isArray(item.evidenceRefs)
          ? item.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim()).map((ref) => ref.trim())
          : [],
      };
    })
    .filter(Boolean);
}

function parseVerifierReport(rawText, fallback = {}) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch {}
      }
    }
  }
  const report = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : { passed: false, risks: [text || fallback.summary || 'Verifier finished without structured output.'] };
  return {
    passed: report.passed === true,
    failedCriteria: normalizeVerifierIssues(report.failedCriteria),
    missingEvidence: normalizeVerifierIssues(report.missingEvidence),
    risks: Array.isArray(report.risks)
      ? report.risks.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [],
    evidenceRefs: Array.isArray(report.evidenceRefs)
      ? report.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim()).map((ref) => ref.trim())
      : [],
    recommendedNextAction: typeof report.recommendedNextAction === 'string'
      ? report.recommendedNextAction
      : undefined,
    summary: typeof report.summary === 'string' && report.summary.trim()
      ? report.summary.trim()
      : report.passed === true
        ? 'Verifier passed.'
        : fallback.summary || 'Verifier found issues.',
  };
}

function parseExplorerReport(rawText, fallback = {}) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch {}
      }
    }
  }
  const report = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : { summary: text || fallback.summary || 'Explorer finished without textual output.' };
  const evidenceRefs = Array.isArray(report.evidenceRefs)
    ? report.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim()).map((ref) => ref.trim())
    : [];
  return {
    summary: typeof report.summary === 'string' && report.summary.trim()
      ? report.summary.trim()
      : fallback.summary || 'Explorer completed.',
    findings: Array.isArray(report.findings) ? report.findings : [],
    evidenceRefs,
    recommendedNextStep: typeof report.recommendedNextStep === 'string' ? report.recommendedNextStep : undefined,
    confidence: ['low', 'medium', 'high'].includes(report.confidence) ? report.confidence : 'medium',
  };
}

const llmChatService = createLlmChatService({
  llmConfigStore,
  conversationStore,
  emitRuntimeEvent,
  persistCompaction: persistCompactionToConversation,
  promptSnapshotStore,
  preferredAccessLevel: initialSettings.localAccessLevel,
  mcpRegistry,
  skillStore,
  automationProposalService,
  // 注入带 onChange 的同一 goalPlanStore 单例，使 AI 工具写计划经唯一写路径广播，
  // 浮条无需切会话即可随流式更新。见 Goal 模式设计。
  goalPlanStore,
  // Agent 工具路径创建 LocalToolHost 时需要同一套 Browser 工作现场 reveal 桥。
  ensureBrowserReady: browserPanelRevealCoordinator.ensureBrowserReady,
  broadcast: broadcastToAllWindows,
  // 全局兜底多模态模型配置（settings.json → fallbackVision）。
  getSettings: () => settingsStore.getAll(),
});
llmChatService.setWorkspacePath(settingsStore.getAll().activeWorkspace || null);

const chatStreamApplicationService = createChatStreamApplicationService({
  abortStream: (streamId) => llmChatService.abort(streamId),
  reattachStream: (input) => llmChatService.reattach(input),
  listActiveConversationIds: () => llmChatService.listActiveConversationIds(),
  listActiveStreams: () => llmChatService.listActiveStreams(),
});

goalRunner = createGoalRunner({
  goalPlanStore,
  chatRuntime: {
    async runGoalTurn({ plan, turnNumber }) {
      const webContents = getRunnerWebContents();
      if (!webContents) {
        return { blocked: true, blockedReason: 'No renderer window is available for Goal Runner' };
      }
      const conversation = conversationStore.getConversation(plan.conversationId);
      if (!conversation) {
        return { failed: true, failureReason: 'Goal conversation not found' };
      }
      const streamId = randomUUID();
      // Goal Runner 执行回合必须主进程落盘：先创建 assistant 占位并拿到 id，
      // 再把 assistantMessageId 同时交给 streamStarted（渲染绑定）与 sendMessage（正文回写）。
      // 没有 assistantMessageId 时 llm-chat-service 会跳过 persistStreamRecord。
      const startedAt = Date.now();
      const { id: assistantMessageId, message: assistantPlaceholder } =
        createGoalRunnerAssistantPlaceholder({ now: startedAt });
      conversationStore.appendMessage(plan.conversationId, assistantPlaceholder);
      broadcastToAllWindows('goalRunner:changed', buildGoalRunnerStreamStartedPayload({
        planId: plan.planId,
        conversationId: plan.conversationId ?? null,
        streamId,
        turnNumber,
        assistantMessageId,
        startedAt,
      }));
      
      const canonicalHistory = projectConversationHistory(conversation.messages);
      const messages = [
        ...toDesktopProviderMessages(canonicalHistory.messages),
        { role: 'user', content: buildGoalRunnerMessage(plan, turnNumber) },
      ];
      const goalContinuityContext = desktopContinuityContextFromProjection(canonicalHistory);
      // Goal Runner 实时计数 sink：把「模型每轮」和「每次工具调用」即时写回 store。
      // setRunnerState 内部 persist→notifyChanged 会广播 goalRunner:changed，
      // 渲染层据此实时刷新底部「轮次 / 工具」数字（roundCount 为展示计数，与预算 turnCount 解耦）。
      const planId = plan.planId;
      const bumpRunnerCount = (field) => {
        const current = goalPlanStore.getPlan(planId)?.runner;
        if (!current) return;
        const prev = Number.isFinite(current[field]) ? current[field] : 0;
        goalPlanStore.setRunnerState(planId, { [field]: prev + 1 });
      };
      // per-run Explorer 请求收集器：模型在本回合内调用 request_explorer 工具时，
      // 经 agentProgress.onToolCall 带上的 input（question/reason/scope）登记到这里。
      // sendMessage 结束后组装成 result.explorers 返回，交给 goal-runner 既有派发循环
      // （normalizeExploreRequests → dispatchExplorer → runExplorer）真正执行，
      // 使底部「explorers x/3」随真实派发增长。explorerId/planId 由 store 兜底补齐。
      const collectedExplorers = [];
      const agentProgress = {
        onRound: () => bumpRunnerCount('roundCount'),
        onToolCall: ({ tool, input } = {}) => {
          bumpRunnerCount('toolCallCount');
          if (tool === 'request_explorer') {
            const req = input && typeof input === 'object' ? input : {};
            const question = typeof req.question === 'string' ? req.question.trim() : '';
            if (!question) return;
            const scope = req.scope && typeof req.scope === 'object' ? req.scope : undefined;
            collectedExplorers.push({
              planId,
              question,
              reason: typeof req.reason === 'string' ? req.reason.trim() : undefined,
              ...(scope ? { scope } : {}),
            });
          }
        },
      };
      const outcome = await llmChatService.sendMessage({
        messages,
        webContents,
        streamId,
        effort: 'default',
        // Runner 归 goal 模式独占(A1):托管推进的 turn 以 goal 模式驱动,使 goal-runner-source
        // 注入续推上下文、goal-mode-gate 放行自驱。plan 为纯审批门,不再托管续推。
        mode: 'goal',
        conversationId: plan.conversationId,
        modelProviderId: resolveConversationModelProviderId({
          conversationId: plan.conversationId,
          conversationStore,
        }),
        assistantMessageId,
        continuityContext: goalContinuityContext,
        runtimeReminders: [buildGoalRunnerReminder(plan, turnNumber)],
        agentProgress,
      });
      // 有 Explorer 请求时返回 explorers，让 Runner 进入 explore 派发分支；
      // 否则维持原有 verify 收尾语义。
      if (collectedExplorers.length > 0) {
        return {
          intent: 'explore',
          explorers: collectedExplorers,
          terminalStatus: outcome?.terminalStatus ?? null,
          toolCallCount: outcome?.toolCallCount ?? 0,
        };
      }
      if (outcome?.requestedUserInput) {
        return {
          requestedUserInput: true,
          blockedReason: 'requested_user_input',
          terminalStatus: outcome.terminalStatus,
          toolCallCount: outcome.toolCallCount ?? 0,
        };
      }
      if (outcome?.terminalStatus === 'error') {
        return {
          failed: true,
          failureReason: 'Goal Runner turn stream failed',
          terminalStatus: outcome.terminalStatus,
          toolCallCount: outcome.toolCallCount ?? 0,
        };
      }
      if (outcome?.terminalStatus === 'aborted') {
        return {
          blocked: true,
          blockedReason: 'Goal Runner turn aborted',
          terminalStatus: outcome.terminalStatus,
          toolCallCount: outcome.toolCallCount ?? 0,
        };
      }
      return {
        terminalStatus: outcome?.terminalStatus ?? null,
        toolCallCount: outcome?.toolCallCount ?? 0,
        usage: outcome?.usage,
      };
    },
  },
  explorerRunner: {
    async runExplorer({ plan, explorer }) {
      const streamId = randomUUID();
      const webContents = createCollectingWebContents();
      broadcastToAllWindows('goalRunner:changed', {
        type: 'goalRunner:explorerStreamStarted',
        planId: plan.planId,
        conversationId: plan.conversationId ?? null,
        changeKind: 'runner-state',
        explorerId: explorer.explorerId,
        streamId,
        startedAt: Date.now(),
      });
      await llmChatService.sendMessage({
        messages: [{ role: 'user', content: buildExplorerMessage({ plan, explorer }) }],
        webContents,
        streamId,
        effort: 'default',
        mode: 'explorer',
        // 旁路只读调查：不写会话正文，避免内部过程进聊天。
        conversationId: null,
        modelProviderId: resolveConversationModelProviderId({
          conversationId: plan.conversationId,
          conversationStore,
        }),
        ephemeral: true,
        explorerContext: buildExplorerContext({ plan, explorer }),
        runtimeReminders: [buildExplorerReminder(explorer)],
      });
      const terminal = webContents.getTerminal();
      if (terminal?.channel === 'chat:stream:error') {
        throw new Error(terminal.payload?.error || 'Explorer stream failed');
      }
      if (terminal?.channel === 'chat:stream:aborted') {
        throw new Error('Explorer stream aborted');
      }
      const report = parseExplorerReport(webContents.getText(), {
        summary: 'Explorer completed without a structured report.',
      });
      const events = webContents.getEvents();
      report.toolCallCount = events.filter((event) => event.channel === 'chat:stream:tool-call').length;
      report.allowedEvidenceRefs = collectExplorerEvidenceRefs(events);
      return report;
    },
  },
  verifierRunner: {
    async runVerifier({ plan, verifierRunId }) {
      const streamId = randomUUID();
      const webContents = createCollectingWebContents();
      broadcastToAllWindows('goalRunner:changed', {
        type: 'goalRunner:verifierStreamStarted',
        planId: plan.planId,
        conversationId: plan.conversationId ?? null,
        changeKind: 'runner-state',
        verifierRunId,
        streamId,
        startedAt: Date.now(),
      });
      await llmChatService.sendMessage({
        messages: [{ role: 'user', content: buildVerifierMessage({ plan, verifierRunId }) }],
        webContents,
        streamId,
        effort: 'default',
        // Verifier 复用 explorer 的只读工具投影；任务语义由 verifierContext Source 注入。
        mode: 'explorer',
        // 验收旁路流：不写会话、不进活跃流投影，JSON 只给 runner 解析。
        conversationId: null,
        modelProviderId: resolveConversationModelProviderId({
          conversationId: plan.conversationId,
          conversationStore,
        }),
        ephemeral: true,
        verifierContext: buildVerifierContext({ plan, verifierRunId }),
        runtimeReminders: [buildVerifierReminder(verifierRunId)],
      });
      const terminal = webContents.getTerminal();
      if (terminal?.channel === 'chat:stream:error') {
        throw new Error(terminal.payload?.error || 'Verifier stream failed');
      }
      if (terminal?.channel === 'chat:stream:aborted') {
        throw new Error('Verifier stream aborted');
      }
      return parseVerifierReport(webContents.getText(), {
        summary: 'Verifier completed without a structured report.',
      });
    },
  },
  emitEvent: (payload) => {
    const planId = payload?.planId ?? null;
    const plan = planId ? goalPlanStore.getPlan(planId) : null;
    broadcastToAllWindows('goalRunner:changed', {
      ...payload,
      planId,
      conversationId: payload?.conversationId ?? plan?.conversationId ?? null,
      changeKind: payload?.changeKind ?? 'runner-state',
    });
  },
});

function buildRuntimeProjection() {
  const session = sessionStore.getSession();
  const baseCapabilities = capabilityRegistry.refreshCapabilities();
  return {
    projectionId: session.sessionId,
    sessionId: session.sessionId,
    accessLevel: session.accessLevel,
    capabilities: baseCapabilities,
    skills: skillStore?.listSkills() ?? [],
    createdAt: new Date().toISOString(),
  };
}

function getRendererIndexPath() {
  return isPackaged
    ? path.join(__dirname, '../../dist/index.html')
    : path.join(workspaceRoot, 'apps/desktop/dist/index.html');
}

function getTrustedRendererLocation() {
  return isDev
    ? new URL(process.env.VITE_DEV_SERVER_URL).toString()
    : pathToFileURL(getRendererIndexPath()).toString();
}

function loadRendererWindow(targetWindow, query = {}) {
  if (isDev) {
    const url = new URL(getTrustedRendererLocation());
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
    void targetWindow.loadURL(url.toString());
  } else {
    void targetWindow.loadFile(getRendererIndexPath(), { query });
  }
}

function createQuickChatWindow() {
  // macOS：透明 + vibrancy，让 renderer glass-popover 透出桌面材质；非 darwin 仅 transparent。
  const isMac = process.platform === 'darwin';
  const quickWindow = new BrowserWindow({
    ...QUICK_CHAT_SIZE,
    minWidth: QUICK_CHAT_SIZE.width,
    maxWidth: QUICK_CHAT_SIZE.width,
    minHeight: QUICK_CHAT_SIZE.height,
    useContentSize: true,
    backgroundColor: '#00000000',
    transparent: true,
    ...(isMac
      ? {
          // HUD/popover material reads closer to native floating capsules.
          vibrancy: 'hud',
          visualEffectState: 'active',
        }
      : {}),
    show: false,
    frame: false,
    roundedCorners: true,
    resizable: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 隐藏态不节流 renderer，避免再次唤醒时先“醒进程”再出首帧。
      backgroundThrottling: false,
    },
  });
  trustedWindowRegistry.registerWindow({
    window: quickWindow,
    role: 'quick-chat',
    allowedLocations: [getTrustedRendererLocation()],
  });
  loadRendererWindow(quickWindow, { window: 'quick-chat' });
  return quickWindow;
}

/** Independent menu host — never shares bounds with the Quick Chat bar (ADR 60). */
function createQuickChatPopoverWindow() {
  const isMac = process.platform === 'darwin';
  const popoverWindow = new BrowserWindow({
    width: 280,
    height: 160,
    minWidth: 120,
    minHeight: 72,
    maxWidth: 360,
    maxHeight: 360,
    useContentSize: true,
    backgroundColor: '#00000000',
    transparent: true,
    ...(isMac
      ? {
          vibrancy: 'popover',
          visualEffectState: 'active',
        }
      : {}),
    show: false,
    frame: false,
    roundedCorners: true,
    resizable: false,
    hasShadow: true,
    skipTaskbar: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  trustedWindowRegistry.registerWindow({
    window: popoverWindow,
    role: 'quick-chat-popover',
    allowedLocations: [getTrustedRendererLocation()],
  });
  loadRendererWindow(popoverWindow, { window: 'quick-chat-popover' });
  return popoverWindow;
}

const quickChatWindowController = createQuickChatWindowController({
  screen,
  createWindow: createQuickChatWindow,
  createPopoverWindow: createQuickChatPopoverWindow,
  Menu,
});

// Appshots P0a (ADR 59): user-gesture-only capture; never exposed as a model tool.
const appshotService = createAppshotService({
  getScreenPermissionStatus: (type = 'screen') => systemPreferences.getMediaAccessStatus(type),
  artifactsDir: path.join(app.getPath('userData'), 'appshot-artifacts'),
  log: (line) => console.log('[appshot]', line),
});

async function handleAppshotHotkey(source = 'hotkey') {
  try {
    // Settings gate (T8): the panel toggle is the single source of truth.
    const appshotSettings = settingsStore.getAll().appshots;
    if (appshotSettings && appshotSettings.enabled === false) {
      console.warn('[appshot] skipped: disabled in settings');
      return { ok: false, code: 'disabled', detail: 'appshots disabled in settings' };
    }
    const preflight = buildAppshotPermissionPreflight({
      getMediaAccessStatus: (type) => systemPreferences.getMediaAccessStatus(type),
    });
    if (!preflight.canCapture) {
      console.warn('[appshot] preflight blocked:', preflight.status);
      void openScreenRecordingSettings({ shellOpenExternal: (url) => shell.openExternal(url) });
      notifyAppshotOutcome(source, { ok: false, code: 'permission_denied' });
      return { ok: false, code: 'permission_denied', detail: preflight.status };
    }
    const result = await appshotService.capture();
    if (!result.ok) {
      console.warn('[appshot] capture failed:', result.code);
      notifyAppshotOutcome(source, result);
      return result;
    }
    // T7: small inline thumbnail for instant card rendering (ADR 59: full image
    // stays on disk; only a bounded-width thumbnail may inline as dataUrl).
    let thumbnailDataUrl;
    try {
      const image = nativeImage.createFromPath(result.payload.visual.filePath);
      if (!image.isEmpty()) {
        const size = image.getSize();
        const width = Math.min(480, size.width);
        thumbnailDataUrl = image.resize({ width }).toDataURL();
      }
    } catch {
      thumbnailDataUrl = undefined; // card falls back to the broken/placeholder state
    }
    const delivery = deliverAppshot({
      payload: result.payload,
      listConversations: () => conversationStore.listConversations({ includeMessageCount: false }),
      createConversation: (input) => conversationStore.createConversation(input),
      appendMessage: (id, message) => conversationStore.appendMessage(id, message),
      options: { thumbnailDataUrl },
    });
    console.log('[appshot] delivered to conversation', delivery.conversationId, delivery.created ? '(new)' : '');
    notifyAppshotOutcome(source, { ok: true, appName: result.payload.source.appName, delivery });
    return { ...result, delivery };
  } catch (err) {
    console.error('[appshot] hotkey handling failed:', err?.message ?? err);
    notifyAppshotOutcome(source, { ok: false, code: 'window_not_capturable' });
    return { ok: false, code: 'window_not_capturable', detail: 'unexpected failure' };
  }
}

/**
 * T9: lightweight capture feedback (product §9).
 * - Never force-reveals the Peer main window (the user stays in their app).
 * - Hotkey path only; settings "test capture" already renders inline feedback.
 * - System notification, silent-failure tolerant; click routes to the conversation
 *   via the existing task-notification reveal path.
 * - Log lines carry outcome codes only — no window titles, no image data (ADR 59).
 */
function notifyAppshotOutcome(source, outcome) {
  if (source !== 'hotkey') return;
  try {
    if (outcome.ok) {
      const notified = showTaskSystemNotification({
        title: 'Appshot',
        body: `已捕获「${outcome.appName}」窗口，已添加到会话。`,
        onClick: () => openConversationFromTaskNotification({
          conversationId: outcome.delivery?.conversationId,
          messageId: outcome.delivery?.messageId,
          source: 'appshot-notification',
        }),
      });
      if (!notified) console.log('[appshot] delivered (notification unavailable)');
      return;
    }
    const bodies = {
      permission_denied: '缺少屏幕录制权限，请在系统设置中授权。',
      peer_frontmost: 'Peer 自身在前台，请切换到要捕获的应用后重试。',
      no_window: '未找到可捕获的前台窗口。',
      window_not_capturable: '该窗口不支持捕获。',
    };
    showTaskSystemNotification({ title: 'Appshot', body: bodies[outcome.code] ?? '捕获失败。' });
  } catch (err) {
    console.warn('[appshot] feedback failed:', err?.message ?? err);
  }
}

const shortcutService = createShortcutService({
  globalShortcut,
  settingsStore,
  onQuickChat: () => quickChatWindowController.toggle(),
  // Appshot: no global accelerator while double-⌘ is deferred (do not occupy ⌘⇧A).
  // Capture remains available via settings "Test capture" / appshot:capture IPC.
});

const settingsApplicationService = createSettingsApplicationService({
  getSettings: () => settingsStore.getAll(),
  mergeSettings: (partial) => settingsStore.merge(partial),
  applyAppearance: (appearance) => {
    const quickWindow = quickChatWindowController.getWindow();
    setDockIcon(appearance);
    quickWindow?.webContents.send('appearance:changed', appearance);
  },
  normalizeSystemInstructions,
  recordInstructionBaseline,
  resolveLocalAccessLevel,
  setSessionAccessLevel: (accessLevel) => sessionStore.setAccessLevel(accessLevel),
  setRuntimeAccessLevel: (accessLevel) => llmChatService.setLocalAccessLevel(accessLevel),
  chooseExportDirectory: async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return canceled ? null : (filePaths?.[0] ?? null);
  },
  chooseImportDirectory: async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择要导入的配置目录',
      properties: ['openDirectory'],
    });
    return canceled ? null : (filePaths?.[0] ?? null);
  },
  exportBundle: (targetDirectory) => exportBundle(targetDirectory),
  importBundle: (sourceDirectory) => importBundle(sourceDirectory),
  diagnostics: () => ({
    dataHome,
    isDev,
    isPackaged,
    resourcesRoot,
    workspaceRoot,
    loadedEnvKeys,
  }),
  setSessionLocale: (locale) => sessionStore.setLocale(locale),
  rebuildAppMenu: () => rebuildAppMenu(),
  getSession: () => sessionStore.getSession(),
});

const permissionGrantService = createPermissionGrantService({
  createId: () => randomUUID(),
  now: () => new Date(),
  resolveGrant: (toolCallId, grant) => llmChatService.resolvePermissionGrant(toolCallId, grant),
});

const hostRestarter = createHostRestarter({ workspaceRoot });
const hostRestartApplicationService = createHostRestartApplicationService({
  workspaceRoot,
  restartHost: (options) => hostRestarter.restartHost(options),
  writePendingTask: (task) => writePendingTask(task),
  reportPendingTaskError: (error) => {
    console.error('[pending-task] failed to persist before restart:', error);
  },
});

const pendingTaskApplicationService = createPendingTaskApplicationService({
  workspaceRoot,
  writePendingTask: (task) => writePendingTask(task),
  consumePendingTask: () => readAndClearPendingTask(),
  peekPendingTask: () => peekPendingTask(),
  clearPendingTask: () => clearPendingTask(),
  reportWorkspaceMismatch: (recordWorkspace, currentWorkspace) => {
    console.warn(
      '[pending-task] workspace mismatch, discarding:',
      recordWorkspace,
      '!=',
      currentWorkspace,
    );
  },
});

const providerConfigurationApplicationService = createProviderConfigurationApplicationService({
  listChannels: () => listChannelDescriptors(),
  listServiceTemplates: () => listServiceTemplates(),
  refreshExpiredOAuth: () => refreshExpiredOAuthProviders({ llmConfigStore }),
  backfillMissingPricing: () => llmConfigStore.backfillMissingPricingFromModelsDev(),
  listProviders: () => llmConfigStore.listProviders(),
  listGroups: () => llmConfigStore.listGroups(),
  addProvider: (config) => llmConfigStore.addProvider(config),
  updateProvider: (id, patch) => llmConfigStore.updateProvider(id, patch),
  duplicateProvider: (id) => llmConfigStore.duplicateProvider(id),
  duplicateModel: (id) => llmConfigStore.duplicateModel(id),
  addModel: (groupId, patch) => llmConfigStore.addModel(groupId, patch),
  removeProvider: (id) => llmConfigStore.removeProvider(id),
  removeGroup: (groupId) => llmConfigStore.removeGroup(groupId),
  setDefault: (id) => llmConfigStore.setDefault(id),
  testConnection: (id) => llmConfigStore.testConnection(id),
  completePrompt: (params) => llmConfigStore.completePrompt(params),
  recordBaseline: (reason, provider) => recordProviderBaseline(reason, provider),
  notifyOAuthRefreshed: ({ reason, refreshed }) => {
    console.info(`[llm] silent oauth refresh (${reason}): refreshed ${refreshed} credential(s)`);
    broadcastToAllWindows('llm:oauth:refreshed', { reason, refreshed });
  },
  reportRefreshError: (error) => {
    console.warn('[llm] silent oauth refresh failed:', error?.message || error);
  },
  reportBackfillResult: (reason, result) => {
    if (result?.updated) {
      console.info(
        `[llm] models.dev pricing backfill (${reason}): updated ${result.updated}/${result.examined}`,
      );
    }
  },
  reportBackfillError: (error) => {
    console.warn('[llm] models.dev pricing backfill failed:', error?.message || error);
  },
});

const providerAccessApplicationService = createProviderAccessApplicationService({
  fetchQuota: (id, force) => fetchProviderSubscriptionQuota({
    providerId: id,
    llmConfigStore,
    force,
    fetchImpl: (url, init) => fetchWithConnectionRecovery(url, init, {
      provider: 'subscription-quota',
      model: 'quota',
    }),
  }),
  listProviders: () => llmConfigStore.listProviders(),
  addProvider: (draft) => llmConfigStore.addProvider(draft),
  updateProvider: (id, patch) => llmConfigStore.updateProvider(id, patch),
  removeProvider: (id) => llmConfigStore.removeProvider(id),
  getCredential: (id) => llmConfigStore.getCredential(id),
  setOAuthTokens: (id, tokens) => llmConfigStore.setOAuthTokens(id, tokens),
  getApiKeyRequestConfig: (id) => llmConfigStore.getApiKeyRequestConfig(id),
  fetchWithRecovery: (url, init, context) => fetchWithConnectionRecovery(url, init, context),
  openExternal: (url) => shell.openExternal(url),
  writeClipboard: (text) => clipboard.writeText(text),
  sendOAuthEvent: (sender, channel, payload) => {
    const target = getOAuthWindowWebContents(sender, BrowserWindow.getAllWindows());
    target?.send(channel, payload);
  },
  recordBaseline: (reason, provider) => recordProviderBaseline(reason, provider),
  reportProjectResolutionError: (error) => {
    console.warn('[oauth] resolve Gemini Code Assist project failed:', error?.message || error);
  },
});

const mcpApplicationService = createMcpApplicationService({
  listInstalled: () => mcpRegistry.listInstalled(),
  listCapabilities: () => mcpRegistry.listCapabilityManifests(),
  listCredentials: () => mcpCredentialStore.listCredentials(),
  putCredential: (item) => mcpCredentialStore.putCredential(item),
  deleteCredential: (credentialRef) => mcpCredentialStore.deleteCredential(credentialRef),
  installServer: (item) => mcpRegistry.install(item),
  upsertServer: (item) => mcpRegistry.upsertServer(item),
  getServer: (serverId) => mcpRegistry.getServer(serverId),
  uninstallServer: (serverId) => mcpRegistry.uninstall(serverId),
  setServerEnabled: (serverId, enabled) => mcpRegistry.setEnabled(serverId, enabled),
  setToolVisibility: (serverId, toolName, visible) =>
    mcpRegistry.setToolVisibility(serverId, toolName, visible),
  updateManifest: (serverId, manifest) => mcpRegistry.updateManifest(serverId, manifest),
  updateHealth: (serverId, health) => mcpRegistry.updateHealth(serverId, health),
  testConnection: (server) =>
    testMcpConnection(server, { credentialResolver: mcpCredentialResolver }),
  probeConnection: (server) =>
    probeMcpConnection(server, { credentialResolver: mcpCredentialResolver }),
  disconnectServer: (server) => disconnectMcp(server),
  waitForOAuthCallback: () => waitForMcpOAuthCallback(),
  closeOAuthCallback: () => closeMcpOAuthCallback(),
  startOAuth: (server) =>
    startMcpOAuth(server, { credentialResolver: mcpCredentialResolver }),
  finishOAuth: (server, authorizationCode) =>
    finishMcpOAuth(server, authorizationCode, { credentialResolver: mcpCredentialResolver }),
  readResource: (server, uri) =>
    readMcpResource(server, uri, { credentialResolver: mcpCredentialResolver }),
  getPrompt: (server, name, args) =>
    getMcpPrompt(server, name, args, { credentialResolver: mcpCredentialResolver }),
  reportCredentialCleanupError: (error) => {
    console.warn('[mcp] failed to remove bound credential:', error?.message ?? error);
  },
});

const conversationApplicationService = createConversationApplicationService({
  listConversations: (params) => conversationStore.listConversations(params),
  listConversationsByWorkspace: (workspacePath, params) =>
    conversationStore.listConversationsByWorkspace(workspacePath, params),
  searchConversations: (params) => conversationStore.searchConversations(params),
  createConversation: (params) => conversationStore.createConversation(params),
  getConversation: (id) => {
    const conv = conversationStore.getConversation(id);
    if (!conv?.contextSnapshot || conv.contextSnapshot.version !== 1) return conv;
    const providers = llmConfigStore.listProviders();
    const boundId = conv.modelProviderId;
    const provider = (boundId && providers.find((p) => p.id === boundId))
      || providers.find((p) => p.isDefault)
      || providers[0]
      || null;
    if (!provider?.contextWindow) return conv;
    const projected = reprojectContextAccountingWindow(
      conv.contextSnapshot,
      provider.contextWindow,
    );
    if (!projected || projected === conv.contextSnapshot) return conv;
    return { ...conv, contextSnapshot: projected };
  },
  updateTitle: (id, title) => conversationStore.updateTitle(id, title),
  updateMode: (id, mode) => conversationStore.updateMode(id, mode),
  updateAutomationCreateContext: (id, context) =>
    conversationStore.updateAutomationCreateContext(id, context),
  updateModelEffort: (id, options) => conversationStore.updateModelEffort(id, options),
  appendMessage: (id, message) => conversationStore.appendMessage(id, message),
  updateLastMessage: (id, content) => conversationStore.updateLastMessage(id, content),
  replaceMessages: (id, messages, options) =>
    conversationStore.replaceMessages(id, messages, options),
  archiveConversation: (id) => conversationStore.archiveConversation(id),
  restoreConversation: (id) => conversationStore.restoreConversation(id),
  pinConversation: (id) => conversationStore.pinConversation(id),
  unpinConversation: (id) => conversationStore.unpinConversation(id),
  reorderPinnedConversations: (ids) => conversationStore.reorderPinnedConversations(ids),
  autoArchiveConversations: (params) => conversationStore.autoArchiveConversations(params),
  deleteConversation: (id) => conversationStore.deleteConversation(id),
  addUsage: (id, usage) => conversationStore.addUsage(id, usage),
  listActiveConversationIds: () => llmChatService.listActiveConversationIds(),
  deletePlanByConversation: (id) => goalPlanStore.deletePlanByConversation(id),
  removeConversationToolArtifacts: (params) => removeConversationToolArtifacts(params),
  reportCascadeFailure: (operation, error) => {
    console.warn(`[main] cascade ${operation} failed:`, error);
  },
});

const browserCoreApplicationService = createBrowserCoreApplicationService({
  getActiveWebContentsId: () => getActiveWebContentsId(),
  registerWebContents: (registration) => registerBrowserWebContents(registration),
  unregisterWebContents: (registration) => unregisterBrowserWebContents(registration),
  rebuildMenu: () => rebuildAppMenu(),
  getBrowserSession: () => session.fromPartition(PEER_BROWSER_PARTITION),
  getWebContentsById: (id) => webContents.fromId(id),
  resolveWindowFromSender: (sender) => BrowserWindow.fromWebContents(sender),
  showSaveDialog: (window, options) => dialog.showSaveDialog(window, options),
  getDownloadsPath: () => app.getPath('downloads'),
  joinPath: (...parts) => path.join(...parts),
  now: () => new Date(),
  writeFile: (targetPath, content) => writeFile(targetPath, content),
});

const browserSessionImportApplicationService = createBrowserSessionImportApplicationService({
  getPlatform: () => process.platform,
  buildPreflight: (platform) => buildSessionImportPreflight({ platform }),
  resolveDragTarget: (platform) => resolveFullDiskAccessDragTarget({
    platform,
    appGetPath: (name) => app.getPath(name),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
  }),
  resolveDragIconDataUrl: (appPath) => resolveDragIconDataUrl(appPath),
  listBrowserSources: () => listChromeBrowserSources(),
  scanProfileSites: (profileId) => scanProfileSites(profileId),
  loadCookiesForSites: (input) => loadCookiesForSites(input),
  getBrowserSession: () => session.fromPartition(PEER_BROWSER_PARTITION),
  applyCookiesToSession: (browserSession, cookies) =>
    applyCookiesToSession(browserSession, cookies),
  redactLoadedCookies: (loaded) => redactLoadedCookies(loaded),
});

const browserFdaDragApplicationService = createBrowserFdaDragApplicationService({
  getPlatform: () => process.platform,
  openSettings: () => openFullDiskAccessSettings({
    shellOpenExternal: (url) => shell.openExternal(url),
  }),
  showFloat: (payload) => fullDiskAccessDragFloatController.show(payload),
  hideFloat: () => fullDiskAccessDragFloatController.hide(),
  setDragging: (dragging) => fullDiskAccessDragFloatController.setDragging?.(dragging),
  schedule: (callback, delay) => setTimeout(callback, delay),
  resolveDragTarget: () => resolveFullDiskAccessDragTarget({
    platform: process.platform,
    appGetPath: (name) => app.getPath(name),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
  }),
  pathSeparator: path.sep,
  pathExists: (candidate) => existsSync(candidate),
  getCachedDragIcon: (appPath) => getCachedFdaDragIcon(appPath),
  startDrag: ({ sender, filePath, dragIcon }) => sender.startDrag({
    file: filePath,
    icon: dragIcon,
  }),
  resolveDragIconDataUrl: (appPath) => resolveDragIconDataUrl(appPath),
  warn: (...args) => console.warn(...args),
});

const passwordVaultFillApplicationService = createPasswordVaultFillApplicationService({
  revealPassword: (id) => passwordVaultStore.revealPassword(id),
  getWebContents: (id) => webContents.fromId(id),
});

const conversationSessionApplicationService = createConversationSessionApplicationService({
  getActiveGoalByConversation: (conversationId) =>
    goalPlanStore.getActivePlanByConversation?.(conversationId) ?? null,
  shouldRecoverGoal: (plan) => shouldRecoverAcceptedGoalRunnerOnConversationOpen(plan),
  scheduleRecovery: (task) => queueMicrotask(task),
  startGoalRunner: (planId) => goalRunner?.start(planId) ?? null,
  markTaskRead: (planId) => taskNotificationBroker?.markTaskRead(planId),
  reportRecoveryFailure: (error) => {
    console.error('[main] recover active goal runner failed:', error?.message || error);
  },
  reportNotificationFailure: (error) => {
    console.warn('[task-notification] markTaskRead failed:', error);
  },
});

const openPathApplicationService = createOpenPathApplicationService({
  openPath: (target) => shell.openPath(target),
  showItemInFolder: (target) => shell.showItemInFolder(target),
});

const workspaceApplicationService = createWorkspaceApplicationService({
  getSettings: () => settingsStore.getAll(),
  mergeSettings: (patch) => settingsStore.merge(patch),
  listConversations: (options) => conversationStore.listConversations(options),
  pathExists: (candidate) => existsSync(candidate),
  basename: (candidate) => path.basename(candidate),
  getDefaultWorkspacePath: () => path.join(app.getPath('home'), 'PeerAgent'),
  ensureDirectory: (candidate) => mkdirSync(candidate, { recursive: true }),
  chooseDirectory: async (sender) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(
      BrowserWindow.fromWebContents(sender),
      { title: '选择项目目录', properties: ['openDirectory'] },
    );
    return canceled ? null : (filePaths?.[0] ?? null);
  },
  setChatWorkspacePath: (candidate) => llmChatService.setWorkspacePath(candidate),
  setSkillWorkspacePath: (candidate) => skillStore?.setWorkspacePath?.(candidate),
  readProjectIndex: (options) => readProjectIndex(options),
});

const fileAccessApplicationService = createFileAccessApplicationService({
  getSettings: () => settingsStore.getAll(),
  pathExists: (candidate) => existsSync(candidate),
  statPath: (candidate) => statSync(candidate),
  readDirectory: (candidate) => readdirSync(candidate, { withFileTypes: true }),
  readFile: (candidate) => readFileSync(candidate),
  writeFile: (candidate, content) => writeFileSync(candidate, content, 'utf8'),
  createDirectory: (candidate) => mkdirSync(candidate, { recursive: false }),
  watchDirectory: (candidate, options, onChange) => fsWatch(candidate, options, onChange),
  executeGit: (cwd, args, options) =>
    execFileAsync('git', ['-C', cwd, ...args], options),
});

const goalApplicationService = createGoalApplicationService({
  listPlanDetails: () => goalPlanStore.listPlanDetails(),
  listPlanDetailsByConversation: (conversationId) =>
    goalPlanStore.listPlanDetailsByConversation(conversationId),
  countAwaitingApprovalsByConversation: () =>
    goalPlanStore.countAwaitingApprovalsByConversation(),
  getPlan: (planId) => goalPlanStore.getPlan(planId),
  createPlan: (draft) => goalPlanStore.createPlan(draft),
  revisePlan: (planId, patch, options) => goalPlanStore.revisePlan(planId, patch, options),
  recordApproval: (planId, approval) => goalPlanStore.recordApproval(planId, approval),
  setPlanStatus: (planId, status) => goalPlanStore.setPlanStatus(planId, status),
  recordManualConfirmation: (planId, confirmation) =>
    goalPlanStore.recordManualConfirmation(planId, confirmation),
  recordTaskEvidence: (planId, taskId, change) =>
    goalPlanStore.recordTaskEvidence(planId, taskId, change),
  deletePlan: (planId) => goalPlanStore.deletePlan(planId),
  startRunner: (planId, options) => goalRunner?.start(planId, options) ?? null,
  getRunnerState: (planId) => goalRunner?.getState(planId) ?? null,
  pauseRunner: (planId) => goalRunner?.pause(planId) ?? null,
  resumeRunner: (planId, options) => goalRunner?.resume(planId, options) ?? null,
  clearRunner: (planId) => goalRunner?.clear(planId) ?? null,
});

function registerDesktopIpcHost() {
  return registerIpcOwners({
  ipc: ipcMain,
  registrations: [
    ...createDesktopIpcRegistrations({
    appshot: {
      capture: () => handleAppshotHotkey('settings-test'),
      getPermissionStatus: () => buildAppshotPermissionPreflight({
        getMediaAccessStatus: (type) => systemPreferences.getMediaAccessStatus(type),
      }),
      openScreenSettings: () => openScreenRecordingSettings({
        shellOpenExternal: (url) => shell.openExternal(url),
      }),
    },
    shortcuts: {
      status: () => shortcutService.status(),
      update: (actionOrAccelerator, accelerator) =>
        shortcutService.update(actionOrAccelerator, accelerator),
      reset: (action) => shortcutService.reset(action),
    },
    quickChat: {
      hide: () => quickChatWindowController.hide(),
      showPopover: (payload) => quickChatWindowController.showPopover(payload),
      setTaskCardVisible: (visible) => quickChatWindowController.setTaskCardVisible(visible),
      setContentHeight: (height) => quickChatWindowController.setContentHeight(height),
      hidePopover: () => quickChatWindowController.hidePopover({ restoreFocus: true }),
      selectPopover: (value) => quickChatWindowController.selectPopoverValue(value),
      submit: (payload) => {
        quickChatWindowController.hide();
        const mainWindow = getPeerAgentMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('quick-chat:conversation-created', payload);
        if (payload.openMainWindow) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('quick-chat:open-conversation', payload);
        }
      },
    },
    bootstrap: {
      getBootstrap: async () => ({
        session: sessionStore.getSession(),
        capabilities: capabilityRegistry.refreshCapabilities(),
        // 冷启动：monorepo git 项目索引不阻塞 bootstrap；projects:list 仍可按需同步读取。
        projects: [],
        activeProjectId: 'workspace-root',
        availableLocales,
        llmProviders: llmConfigStore.listProviders(),
      }),
      getSession: () => sessionStore.getSession(),
      listCapabilities: () => capabilityRegistry.refreshCapabilities(),
      listProjects: () => readProjectIndex({ workspaceRoot: resourcesRoot }),
      getRuntimeProjection: () => buildRuntimeProjection(),
    },
    updater: {
      getStatus: () => getUpdaterStatus(),
      check: () => checkForUpdates(),
      download: () => downloadUpdate(),
      install: () => {
        const updaterStatus = getUpdaterStatus();
        if (
          process.platform === 'win32'
          && updaterStatus?.enabled === true
          && updaterStatus?.phase === 'downloaded'
          && desktopLifecycleBinding
        ) {
          return desktopLifecycleBinding.shutdown({ resume: () => quitAndInstall() });
        }
        return quitAndInstall();
      },
      openInstaller: () => openInstaller(),
      openReleasePage: () => openReleasePage(),
      setChannel: (preference) => {
        // settings 是通道偏好的权限真相，先写回再切换运行时配置。
        const pref =
          preference === 'beta' || preference === 'stable' || preference === 'auto'
            ? preference
            : 'auto';
        settingsStore.merge({ updateChannel: pref });
        const status = setChannelPreference(pref);
        // 切换通道后用新通道重新检查一次（事件会经 updater:event 广播给渲染层）。
        void checkForUpdates();
        return status;
      },
    },
    }),
    ...createSettingsIpcRegistrations({
      settings: settingsApplicationService,
      permissions: permissionGrantService,
    }),
    ...createHostIpcRegistrations({
      os: {
        getStartupPermissions: async () => {
          try {
            return await buildStartupOsPermissionsPayload();
          } catch (error) {
            return {
              ok: false,
              blocked: true,
              checks: [],
              required: [],
              error: error?.message || 'startup_permissions_failed',
            };
          }
        },
      },
      host: hostRestartApplicationService,
    }),
    ...createBrowserIpcRegistrations({
      browser: browserCoreApplicationService,
      sessionImport: browserSessionImportApplicationService,
      fdaDrag: browserFdaDragApplicationService,
      panelReveal: browserPanelRevealCoordinator,
    }),
    ...createChatIpcRegistrations({
      chat: {
        send: handleChatSend,
        startTask: handleChatStartTask,
        abort: (payload) => chatStreamApplicationService.abort(payload),
        reattach: (payload) => chatStreamApplicationService.reattach(payload),
        listActive: () => chatStreamApplicationService.listActive(),
        compact: handleChatCompact,
        getCompaction: ({ conversationId } = {}) => getCompaction(conversationId),
        contextRestored: handleChatContextRestored,
      },
    }),
    ...createConversationSessionIpcRegistrations({
      conversationSession: conversationSessionApplicationService,
    }),
    ...createDataIpcRegistrations({
      conversations: conversationApplicationService,
      promptSnapshots: {
        list: (params) => promptSnapshotStore.list(params),
        get: (id) => promptSnapshotStore.get(id),
        listContextEpochs: (params) => promptSnapshotStore.listContextEpochs(params),
        listContextEpochEvents: (params) => promptSnapshotStore.listContextEpochEvents(params),
        getContextEpochChain: (params) => promptSnapshotStore.getContextEpochChain(params),
      },
      usage: {
        stats: () => collectUsageStats({ conversationStore, llmConfigStore }),
        daily: (params) => collectUsageDaily(params),
        day: (params) => collectUsageDay({ ...params, llmConfigStore }),
        cacheHitRate: () => collectCacheHitRateMetrics(),
      },
    }),
    ...createAutomationIpcRegistrations({
      automations: automationApplicationService,
      proposals: automationProposalService,
    }),
    ...createTaskOverviewIpcRegistrations({
      taskOverview: taskOverviewAggregator,
    }),
    ...createGoalIpcRegistrations({
      goalPlans: goalApplicationService,
      goalRunner: {
        getState: (payload) => goalApplicationService.getRunnerState(payload),
        start: (payload) => goalApplicationService.startRunner(payload),
        pause: (payload) => goalApplicationService.pauseRunner(payload),
        resume: (payload) => goalApplicationService.resumeRunner(payload),
        clear: (payload) => goalApplicationService.clearRunner(payload),
      },
    }),
    ...createRuntimeHostIpcRegistrations({
      shell: {
        openPath: (payload) => openPathApplicationService.open(payload),
        listTasks: () => localToolHost?.listShellTasks() ?? [],
        stopActiveTask: () => localToolHost?.stopActiveShellTask() ?? false,
        stopTask: (taskId) => localToolHost?.stopShellTask(taskId) ?? false,
        listPermissionRules: () => localToolHost?.permissionReview.listShellRules() ?? [],
        addPermissionRule: (payload) => {
          if (!localToolHost) throw new Error('local_tool_host_not_ready');
          return localToolHost.permissionReview.addShellRule(payload);
        },
      },
      clientTool: {
        execute: (payload) => {
          if (!localToolHost) throw new Error('local_tool_host_not_ready');
          return localToolHost.execute(
            { call: payload?.call },
            { localApproval: payload?.grant, source: 'renderer_client_tool_polling' },
          );
        },
      },
    }),
    ...createSkillsIpcRegistrations({
      skills: {
        list: () => skillStore?.listSkills() ?? [],
        getDetail: (skillId) => {
          if (!skillStore) throw new Error('skill_store_not_available');
          return skillStore.getSkillDetail(skillId);
        },
        refresh: () => {
          skillStore?.refresh();
          return skillStore?.listSkills() ?? [];
        },
        upload: (zipBase64) => {
          if (!skillStore) throw new Error('skill_store_not_available');
          return skillStore.installSkillFromZip(Buffer.from(zipBase64, 'base64'));
        },
        enable: (skillId) => {
          if (!skillStore) throw new Error('skill_store_not_available');
          return skillStore.enableSkill(skillId);
        },
        disable: (skillId) => {
          if (!skillStore) throw new Error('skill_store_not_available');
          return skillStore.disableSkill(skillId);
        },
        listAvailable: () => skillStore?.listAvailableSkills() ?? [],
        link: (skillId) => {
          if (!skillStore) throw new Error('skill_store_not_available');
          return skillStore.linkSkill(skillId);
        },
        unlink: (skillId) => {
          if (!skillStore) throw new Error('skill_store_not_available');
          return skillStore.unlinkSkill(skillId);
        },
        uninstall: (skillId) => {
          if (!skillStore) throw new Error('skill_store_not_available');
          return skillStore.uninstallSkill(skillId);
        },
        marketplaceList: () => skillMarketplaceService?.list() ?? { schemaVersion: 1, catalogId: 'peer-agent', generatedAt: '', entries: [] },
        marketplaceGetDetail: (catalogId) => skillMarketplaceService?.getDetail(catalogId) ?? null,
        marketplaceInstall: (catalogId) => {
          if (!skillMarketplaceService) return { ok: false, error: 'skill_marketplace_not_available' };
          return skillMarketplaceService.install(catalogId);
        },
        skillHubQuery: (query) => {
          if (!skillHubMarketplaceService) throw new Error('skillhub_marketplace_not_available');
          return skillHubMarketplaceService.query(query);
        },
        skillHubGetDetail: (identity) => {
          if (!skillHubMarketplaceService) throw new Error('skillhub_marketplace_not_available');
          return skillHubMarketplaceService.getDetail(identity);
        },
        skillHubGetStatus: () => skillHubMarketplaceService?.getStatus() ?? { status: 'idle', nextPage: 1, total: 0, indexed: 0, updatedAt: null, error: null },
        skillHubSync: (options) => {
          if (!skillHubMarketplaceService) throw new Error('skillhub_marketplace_not_available');
          return skillHubMarketplaceService.sync(options);
        },
        skillHubInstall: (identity) => {
          if (!skillHubMarketplaceService) throw new Error('skillhub_marketplace_not_available');
          return skillHubMarketplaceService.install(identity);
        },
        skillHubListCategories: () => {
          if (!skillHubMarketplaceService) throw new Error('skillhub_marketplace_not_available');
          return skillHubMarketplaceService.listCategories();
        },
      },
    }),
    ...createPendingTaskIpcRegistrations({
      pendingTask: pendingTaskApplicationService,
    }),
    ...createMcpIpcRegistrations({
      mcp: mcpApplicationService,
    }),
    ...createPasswordVaultIpcRegistrations({
      passwordVault: {
        listEntries: () => passwordVaultStore.listEntries(),
        listForOrigin: (origin) => passwordVaultStore.listForOrigin(origin),
        upsertEntry: (payload) => passwordVaultStore.upsertEntry(payload),
        deleteEntry: (id) => passwordVaultStore.deleteEntry(id),
        revealPassword: (id) => passwordVaultStore.revealPassword(id),
        fill: (payload) => passwordVaultFillApplicationService.fill(payload),
      },
    }),
    ...createProviderConfigurationIpcRegistrations({
      providers: providerConfigurationApplicationService,
    }),
    ...createProviderAccessIpcRegistrations({
      providers: providerAccessApplicationService,
    }),
    ...createWorkspaceIpcRegistrations({
      workspace: workspaceApplicationService,
    }),
    ...createFileAccessIpcRegistrations({
      fileAccess: fileAccessApplicationService,
    }),
  ],
  });
}

function createWindow() {
  // macOS 原生毛玻璃：透明底 + vibrancy，让渲染层 --glass-* 半透明色透出桌面材质。
  // 非 darwin 保持实色背景，避免 Win/Linux 透明窗体闪黑或合成异常。
  const isMac = process.platform === 'darwin';
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1040,
    minHeight: 720,
    title: 'Peer Agent',
    // 冷启动首帧前不要把空窗露出来：show:false + ready-to-show 再显示。
    // 否则 macOS 透明底会在 HTML/CSS 注入前短暂露黑（「首次打开黑一下，第二次正常」）。
    show: false,
    backgroundColor: isMac ? '#00000000' : '#1e1e2e',
    ...(isMac
      ? {
          transparent: true,
          vibrancy: 'sidebar',
          visualEffectState: 'active',
          // 相对 hiddenInset 默认原点下移，使三点在约 40px 标题栏内垂直居中
          //（对照 Codex 观感；仅 macOS 生效）。
          trafficLightPosition: { x: 16, y: 18 },
        }
      : {}),
    titleBarStyle: 'hiddenInset',
    icon: getDesktopIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
  });
  mainWindow.__peerAgentMainWindow = true;
  trustedWindowRegistry.registerWindow({
    window: mainWindow,
    role: 'main',
    allowedLocations: [getTrustedRendererLocation()],
  });

  // 全屏状态作为窗口的权威事实，由主进程广播给渲染层。
  // macOS 原生全屏会隐藏交通灯，但 :fullscreen CSS 伪类在 Electron 原生全屏下不可靠，
  // 因此渲染层不能自行推断，必须以此事件为准来收掉为交通灯预留的顶部留白。
  const sendFullscreenState = () => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:fullscreen-changed', {
      fullscreen: mainWindow.isFullScreen(),
    });
  };
  mainWindow.on('enter-full-screen', sendFullscreenState);
  mainWindow.on('leave-full-screen', sendFullscreenState);
  // 渲染层挂载完成后补发一次初始状态，避免错过加载期间的全屏切换。
  mainWindow.webContents.on('did-finish-load', sendFullscreenState);

  let shown = false;
  const revealMainWindow = () => {
    if (shown || mainWindow.isDestroyed()) return;
    shown = true;
    if (!mainWindow.isVisible()) mainWindow.show();
  };
  // 首屏内容可画时再 show，避免冷启动透明窗体闪黑。
  mainWindow.once('ready-to-show', revealMainWindow);
  // 兜底：个别环境 ready-to-show 可能不触发，did-finish-load 后再尝试一次。
  mainWindow.webContents.once('did-finish-load', () => {
    // 给渲染层一帧机会提交样式，再 reveal。
    setTimeout(revealMainWindow, 0);
  });

  loadRendererWindow(mainWindow);
  return mainWindow;
}

// ── 应用菜单（方案 B：⌘R 收归刷新内嵌浏览器页）──
// 替换 Electron 默认菜单，移除生产环境的整窗 Reload/Force Reload；
// ⌘R 改为刷新当前活跃 webview，无活动浏览器页时置灰。需在「语言切换」「浏览器页
// 注册/注销」时重建，使 label 跟随语言、enabled 态跟随是否有活动浏览器页。
function rebuildAppMenu() {
  const menu = buildAppMenu({
    isDev,
    locale: sessionStore.getSession().locale,
    hasActiveBrowser: getActiveWebContentsId() != null,
    onReloadBrowser: () => {
      const id = getActiveWebContentsId();
      if (id == null) return;
      const wc = webContents.fromId(id);
      if (wc && !wc.isDestroyed()) wc.reload();
    },
  });
  Menu.setApplicationMenu(menu);
}

/**
 * 站点会话导入（仅 Cookie，不导入密码）。
 * - list-sources: 发现本机 Chromium 系浏览器 Profile 摘要
 * - list-sites: 扫描选定 Profile 的站点聚合（无 value）
 * - import-site-session: 解密选定站点 Cookie 并写入 persist:peer-browser
 */


function resolveAppIconNativeImage(appPath) {
  // 固定优先使用 Peer Agent 品牌资源（logo/icon），不要回落到系统通用占位图。
  // 这样权限卡展示的是“我们的 LOGO”，不是蓝色 App 方块。
  // 注意：打包态 workspaceRoot 为 null，禁止 path.join(null, ...)，否则拖拽会炸：
  // "The \"path\" argument must be of type string. Received null"
  const candidates = [];
  // monorepo / pack / installed resources
  if (workspaceRoot) {
    candidates.push(
      path.join(workspaceRoot, 'apps/desktop/public/logo.png'),
      path.join(workspaceRoot, 'apps/desktop/build/icon.png'),
      path.join(workspaceRoot, 'apps/desktop/build/icon.icns'),
    );
  }
  candidates.push(
    path.join(__dirname, '../../public/logo.png'),
    path.join(__dirname, '../../dist/logo.png'),
    path.join(__dirname, '../../build/icon.png'),
    path.join(__dirname, '../../build/icon.icns'),
    path.join(__dirname, '../../dist/favicon.png'),
  );
  // packaged app.asar.unpacked / Resources
  try {
    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, 'logo.png'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'logo.png'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'public', 'logo.png'),
      );
    }
  } catch { /* ignore */ }
  if (appPath && typeof appPath === 'string') {
    candidates.push(
      path.join(appPath, 'Contents', 'Resources', 'icon.icns'),
      path.join(appPath, 'Contents', 'Resources', 'app-icons', 'icon.icns'),
      path.join(appPath, 'Contents', 'Resources', 'logo.png'),
      // electron.icns 放到最后，避免开发态误显示 Electron 默认图标语义
      path.join(appPath, 'Contents', 'Resources', 'electron.icns'),
    );
  }
  for (const file of candidates) {
    try {
      if (!file || !existsSync(file)) continue;
      const img = nativeImage.createFromPath(file);
      if (img && !img.isEmpty()) return img;
    } catch {
      // continue
    }
  }
  return nativeImage.createEmpty();
}

async function resolveDragIconDataUrl(appPath) {
  try {
    let icon = resolveAppIconNativeImage(appPath);
    if (icon.isEmpty() && appPath) {
      try {
        icon = await app.getFileIcon(appPath, { size: 'normal' });
      } catch {
        // ignore
      }
    }
    if (icon && !icon.isEmpty()) return icon.toDataURL();
  } catch {
    // ignore
  }
  return null;
}


function resolveFdaFloatLogoPath() {
  const candidates = [
    workspaceRoot ? path.join(workspaceRoot, 'apps/desktop/public/logo.png') : null,
    workspaceRoot ? path.join(workspaceRoot, 'apps/desktop/dist/logo.png') : null,
    path.join(__dirname, '../../public/logo.png'),
    path.join(__dirname, '../../dist/logo.png'),
    path.join(__dirname, '../../build/icon.png'),
    process.resourcesPath ? path.join(process.resourcesPath, 'logo.png') : null,
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'logo.png') : null,
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (file && existsSync(file)) return file;
    } catch { /* continue */ }
  }
  return null;
}

/** 浮窗在 sandbox data: HTML 里，file:// 往往裂图；改为 data URL。 */
function resolveFdaFloatLogoDataUrl() {
  try {
    const file = resolveFdaFloatLogoPath();
    if (file) {
      const img = nativeImage.createFromPath(file);
      if (img && !img.isEmpty()) {
        const dataUrl = img.toDataURL();
        if (dataUrl) return dataUrl;
      }
    }
  } catch { /* fall through */ }
  try {
    // 再走统一图标解析（已对 workspaceRoot null 安全）
    const drag = resolveFullDiskAccessDragTarget({
      platform: process.platform,
      appGetPath: (name) => app.getPath(name),
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
    });
    const icon = resolveAppIconNativeImage(drag?.ok ? drag.appPath : '');
    if (icon && !icon.isEmpty()) {
      const dataUrl = icon.toDataURL();
      if (dataUrl) return dataUrl;
    }
  } catch { /* fall through */ }
  return null;
}

let cachedFdaDragIcon = null; // NativeImage, resized for smooth startDrag
let cachedFdaDragIconKey = '';

function getCachedFdaDragIcon(filePath) {
  const key = String(filePath || '');
  if (cachedFdaDragIcon && !cachedFdaDragIcon.isEmpty() && cachedFdaDragIconKey === key) {
    return cachedFdaDragIcon;
  }
  let icon = resolveAppIconNativeImage(filePath);
  if (icon.isEmpty()) {
    const logoFallbacks = [
      workspaceRoot ? path.join(workspaceRoot, 'apps/desktop/public/logo.png') : null,
      path.join(__dirname, '../../public/logo.png'),
      path.join(__dirname, '../../dist/logo.png'),
      process.resourcesPath ? path.join(process.resourcesPath, 'logo.png') : null,
    ].filter(Boolean);
    for (const f of logoFallbacks) {
      try {
        if (!existsSync(f)) continue;
        const img = nativeImage.createFromPath(f);
        if (img && !img.isEmpty()) { icon = img; break; }
      } catch { /* continue */ }
    }
  }
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W7tUAAAAASUVORK5CYII=',
    );
  } else {
    // 关键：startDrag 用大图会非常卡、不跟手；缩到 48px
    try {
      const size = icon.getSize();
      if (size.width > 48 || size.height > 48) {
        icon = icon.resize({ width: 48, height: 48, quality: 'better' });
      }
    } catch { /* keep original */ }
  }
  cachedFdaDragIcon = icon;
  cachedFdaDragIconKey = key;
  return icon;
}

const fullDiskAccessDragFloatController = createFullDiskAccessDragFloatController({

  BrowserWindow,
  screen,
  path,
  existsSync,
  preloadPath: path.join(__dirname, '../preload/preload.cjs'),
  resolveDragTarget: () => resolveFullDiskAccessDragTarget({
    platform: process.platform,
    appGetPath: (name) => app.getPath(name),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
  }),
  resolveLogoFilePath: resolveFdaFloatLogoPath,
  resolveLogoDataUrl: resolveFdaFloatLogoDataUrl,
  registerTrustedWindow: ({ window, url }) => trustedWindowRegistry.registerWindow({
    window,
    role: 'permission-drag-float',
    allowedLocations: [url],
  }),
  isZh: () => {
    try {
      // best-effort locale; renderer also passes isZh when available
      return app.getLocale().toLowerCase().startsWith('zh');
    } catch {
      return true;
    }
  },
});

async function buildStartupOsPermissionsPayload() {
  const snapshot = buildStartupOsPermissions({
    platform: process.platform,
    includeDragTarget: true,
    appGetPath: (name) => app.getPath(name),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
  });
  const dragTarget = snapshot.dragTarget || resolveFullDiskAccessDragTarget({
    platform: process.platform,
    appGetPath: (name) => app.getPath(name),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
  });
  const iconDataUrl = dragTarget?.ok && dragTarget.appPath
    ? await resolveDragIconDataUrl(dragTarget.appPath)
    : null;
  return {
    ...snapshot,
    dragTarget: dragTarget?.ok
      ? {
          ok: true,
          appPath: dragTarget.appPath,
          displayName: dragTarget.displayName,
          kind: dragTarget.kind,
          isPackagedApp: dragTarget.isPackagedApp,
          iconDataUrl,
        }
      : {
          ok: false,
          error: dragTarget?.error || 'app_path_not_found',
        },
  };
}

// ── LLM Chat ──
function latestUserTextFromProviderMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content.trim();
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

// 方案 C —— goal 模式 intake 判别收敛（首答回合结束后执行）。
// 背景：goal 模式首答走普通 sendMessage（不经 Runner），而 Runner 里的
// intake 三选一收敛此路径下不会触发，导致纯问答后 intake 契约永久残留“执行中 0/1”。
// 本函数在首答回合结束后补齐同一套收敛，口径与 goal-runner.mjs 的 intake 收敛块保持一致：
//   - 纯问答/咨询：仍是 intake 契约、未提问、回合正常结束 → deletePlan 静默移除，
//     还原普通聊天体验（deletePlan 会 notifyChanged，面板随之清空）。
//   - 模糊澄清：模型调用 request_user_input（outcome.requestedUserInput=true）→ 保留
//     intake 契约，等待用户下一轮回复，不删。
//   - 明确目标：模型调用 goal_create_plan → upsertGoalContract 已把本契约原地升级为
//     accepted_goal（activation.kind 不再是 intake）→ 本函数直接跳过，落入正常自驱推进。
//   - 出错/中止的回合不在此误删，保留契约交由既有失败链路处理。

function maybeAutoStartAcceptedGoalFromPlanChange(payload = {}) {
  const planId = typeof payload?.planId === 'string' ? payload.planId : null;
  if (!planId) return;
  const plan = goalPlanStore.getPlan?.(planId) || goalPlanStore.getActivePlanByConversation?.(payload.conversationId);
  if (!shouldAutoStartAcceptedGoalRunnerFromChange(payload, plan)) return;
  if (!goalRunner) return;
  // 串行收口同会话 intake 流：等待原 sendMessage finally 释放 Runtime turn 后，
  // 再启动 Runner。仅发送 UI done 或同步 cancel 都不足以证明 session 已空闲。
  void serializeAcceptedGoalRunnerHandoff({
    forceComplete: () => llmChatService?.forceCompleteConversationStreams?.(
      plan.conversationId,
      { reason: 'goal_handoff' },
    ) ?? { released: Promise.resolve() },
    isStillAccepted: () => shouldAutoStartAcceptedGoalRunner(goalPlanStore.getPlan?.(plan.planId)),
    startRunner: () => goalRunner.start(plan.planId),
  }).catch((error) => {
    console.error('[main] plan-change auto-start goal runner failed:', error?.message || error);
  });
}

function convergeIntakeAfterGoalTurn(conversationId, outcome) {
  try {
    if (
      typeof goalPlanStore.listPlansByConversation !== 'function'
      || typeof goalPlanStore.getPlan !== 'function'
    ) return;
    const intake = goalPlanStore.listPlansByConversation(conversationId)
      .map((meta) => goalPlanStore.getPlan(meta.planId))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .find((plan) => plan?.activation?.kind === 'intake') ?? null;
    const decision = decideIntakeConvergence(intake, outcome);
    // request_user_input is the final action-owner fact of the turn. It must
    // override a goal_update_task(completed) that happened earlier in the same
    // turn, otherwise Task Overview sees only completed → result_ready.
    if (decision === 'keep' && typeof goalPlanStore.markRequestedUserInput === 'function') {
      goalPlanStore.markRequestedUserInput(intake.planId);
    } else if (decision === 'remove') {
      goalPlanStore.deletePlan(intake.planId);
    }
  } catch (error) {
    console.warn('[main] intake convergence failed:', error?.message || error);
  }
}

async function handleChatStartTask({
  text,
  title,
  workspacePath,
  mode = 'goal',
  effort,
  modelProviderId,
  attachments = [],
} = {}, sender) {
  const normalizedText = String(text ?? '').trim();
  if (!normalizedText && (!Array.isArray(attachments) || attachments.length === 0)) {
    throw new Error('task_text_or_attachment_required');
  }
  const conversation = conversationStore.createConversation({
    title: String(title ?? normalizedText).slice(0, 48) || '新任务',
    workspacePath: workspacePath ?? settingsStore.getAll().activeWorkspace ?? null,
    mode,
  });
  if (effort !== undefined || modelProviderId !== undefined) {
    conversationStore.updateModelEffort(conversation.id, {
      effort,
      modelProviderId,
    });
  }
  const now = new Date().toISOString();
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const streamId = randomUUID();
  conversationStore.appendMessage(conversation.id, {
    id: userMessageId,
    role: 'user',
    content: normalizedText,
    timestamp: now,
    ...(Array.isArray(attachments) && attachments.length > 0 ? { attachments } : {}),
  });
  conversationStore.appendMessage(conversation.id, {
    id: assistantMessageId,
    role: 'assistant',
    content: '',
    timestamp: now,
    segments: [],
  });
  void Promise.resolve(handleChatSend({
    streamId,
    assistantMessageId,
    effort,
    mode,
    conversationId: conversation.id,
    modelProviderId,
    workspacePath: conversation.workspacePath ?? workspacePath ?? null,
  }, sender)).catch((error) => {
    console.error('[main] background task failed:', error);
  });
  return {
    conversationId: conversation.id,
    streamId,
    assistantMessageId,
  };
}

function handleChatSend({
  messages: legacyMessages,
  streamId,
  effort,
  mode,
  conversationId,
  modelProviderId,
  workspacePath,
  assistantMessageId,
  contextAttachments,
  runtimeReminders,
  attachmentContext,
  continuityContext,
  configInstructions,
  contextExtensions,
}, sender) {
  const persistedConversation = conversationId
    ? conversationStore.getConversation(conversationId)
    : null;
  const persistedProjection = persistedConversation?.messages
    ? projectConversationHistory(persistedConversation.messages)
    : null;
  const messages = persistedProjection
    ? toDesktopProviderMessages(persistedProjection.messages)
    : Array.isArray(legacyMessages)
      ? legacyMessages
      : [];
  const resolvedContinuityContext = persistedConversation?.messages
    ? desktopContinuityContextFromProjection(persistedProjection)
    : continuityContext;
  let answeredRequestedUserInputPlanId = null;
  // Agent 默认（chat）与 legacy goal 共享 intake / 路由契约。
  if ((mode === 'goal' || mode === 'chat') && conversationId && typeof goalPlanStore.upsertGoalContract === 'function') {
    const goal = latestUserTextFromProviderMessages(messages);
    if (goal) {
      try {
        const activePlan = goalPlanStore.getActivePlanByConversation(conversationId);
        const activeGoal = activePlan && goalPlanIsSelfDriven(activePlan) ? activePlan : null;
        const route = routeGoalMessage({ messageText: goal, activeGoalPlan: activeGoal });
        if (route.type === 'append_goal_event') {
          const answersRequestedUserInput = consumesRequestedUserInput({
            route,
            activeGoalPlan: activeGoal,
          });
          applyGoalMessageRoute({
            route,
            activeGoalPlan: activeGoal,
            goalPlanStore,
          });
          if (answersRequestedUserInput) {
            answeredRequestedUserInputPlanId = activeGoal.planId;
          }
        } else if (route.type === 'start_intake') {
          const conversationWorkspacePath =
            conversationStore.getConversation(conversationId)?.workspacePath ||
            workspacePath ||
            null;
          // 「先判别再建目标」：用户在 goal 模式下的首发消息不再无条件建成 accepted 目标。
          // 若本会话尚无活跃自驱目标，则建一条 intake 判别契约（activation=intake），
          // 由 Runner 在只读/问答/澄清的受限授权下判定这究竟是纯问答还是真实目标；
          // 判为问答会被静默移除，判为明确目标才会 promoteIntakeToGoal 升级为 accepted_goal。
          if (!activeGoal && typeof goalPlanStore.createIntakeContract === 'function') {
            goalPlanStore.createIntakeContract({
              conversationId,
              ...(conversationWorkspacePath ? { originWorkspacePath: conversationWorkspacePath } : {}),
              title: goal.length > 48 ? `${goal.slice(0, 48)}...` : goal,
              goal,
              createdBy: 'user',
            });
          } else {
            // 已存在活跃目标时的显式「新建目标」属于边缘场景，沿用既有 upsert 语义，
            // 避免在有目标进行中的情况下产生第二条悬空 intake 契约。
            goalPlanStore.upsertGoalContract(conversationId, {
              conversationId,
              ...(conversationWorkspacePath ? { originWorkspacePath: conversationWorkspacePath } : {}),
              title: goal.length > 48 ? `${goal.slice(0, 48)}...` : goal,
              goal,
              status: 'accepted',
              workflowKind: 'goal_self_driven',
              activation: {
                kind: 'accepted_goal',
                acceptedAt: new Date().toISOString(),
                acceptedBy: 'user',
              },
              createdBy: 'user',
            });
          }
        }
      } catch (error) {
        console.warn('[main] goal contract bootstrap failed:', error?.message || error);
      }
    }
  }
  // 会话级首选 provider：渲染端透传优先，缺省时按 conversationId 从会话 meta 兜底解析，
  // 保证「模型随会话绑定」在续传/重载等渲染端未带参场景下仍以后端 store 为真值。
  const resolvedModelProviderId =
    modelProviderId
    ?? (conversationId ? conversationStore.getConversation(conversationId)?.modelProviderId ?? null : null);
  const outcomePromise = llmChatService.sendMessage({
    messages,
    webContents: sender,
    streamId,
    effort,
    mode,
    conversationId,
    modelProviderId: resolvedModelProviderId,
    // B2 兜底：透传渲染端当前工作区，仅在会话未绑定 workspacePath 时由
    // resolveRunWorkspacePath 作为兜底/校验使用，主真值仍按 conversationId 从 store 解析。
    workspacePath,
    assistantMessageId,
    contextAttachments,
    runtimeReminders,
    attachmentContext,
    continuityContext: resolvedContinuityContext,
    configInstructions,
    contextExtensions,
  });
  // goal 模式首答回合结束后补 intake 判别收敛（方案 C）：不改变返回给渲染端的 outcome，
  // 仅在回合 resolve 后按 outcome 决定是否静默移除残留的 intake 契约。
  if ((mode === 'goal' || mode === 'chat') && conversationId) {
    return Promise.resolve(outcomePromise).then((outcome) => {
      convergeIntakeAfterGoalTurn(conversationId, outcome);
      const acceptedGoal = goalPlanStore.getActivePlanByConversation(conversationId);
      if (answeredRequestedUserInputPlanId) {
        // The user's answer ran in the foreground chat turn. Hand ownership back
        // only after that turn has released the conversation runtime, and re-read
        // persisted state before starting so a new block/completion wins the race.
        void serializeAcceptedGoalRunnerHandoff({
          forceComplete: () => llmChatService?.forceCompleteConversationStreams?.(
            conversationId,
            { reason: 'goal_user_decision_handoff' },
          ) ?? { released: Promise.resolve() },
          isStillAccepted: () => shouldResumeGoalRunnerAfterUserDecision(
            goalPlanStore.getPlan?.(answeredRequestedUserInputPlanId),
          ),
          startRunner: () => goalRunner?.start(answeredRequestedUserInputPlanId),
        }).catch((error) => {
          console.error('[main] resume goal runner after user decision failed:', error?.message || error);
        });
      } else if (shouldAutoStartAcceptedGoalRunner(acceptedGoal)) {
        // intake 路径下 createIntakeContract 初始 status 为 executing；goal_create_plan
        // 原地升级后 activation.kind=accepted_goal，但 status 可能仍是 executing。
        queueMicrotask(() => {
          void goalRunner?.start(acceptedGoal.planId).catch((error) => {
            console.error('[main] auto-start goal runner failed:', error?.message || error);
          });
        });
      }
      return outcome;
    });
  }
  return outcomePromise;
}

// ── Stream reattach (ADR 22) ──
// renderer 经 HMR 重载或重新打开后,内存里的流式状态丢失,但 main 进程的
// 流式推理仍在继续。renderer 挂载时由 chat-ipc owner 投影到共享流服务。

// 全局活跃流查询也由 chat-ipc owner 投影；服务保留既有 conversationIds 与 streams 形状。

async function handleChatCompact({ conversationId, streamId }, sender) {
  const conv = conversationStore.getConversation(conversationId);
  if (!conv || !conv.messages?.length) return { compacted: false };

  const filteredMessages = conv.messages.filter(
    (m) => !(m.role === 'user' && typeof m.content === 'string' && m.content.trim() === '/compact'),
  );
  if (filteredMessages.length === 0) return { compacted: false };
  const canonicalHistory = projectConversationHistory(filteredMessages);
  const priorContinuityContext = desktopContinuityContextFromProjection(canonicalHistory);
  const activeSourceMessages = filteredMessages.slice(canonicalHistory.compactionBoundaryIndex + 1);
  if (canonicalHistory.messages.length === 0) return { compacted: false };

  const workspacePath = settingsStore.getAll().activeWorkspace || null;

  const compactProviders = llmConfigStore.listProviders().filter((p) => p.apiKeyConfigured);
  const provider = compactProviders.find((p) => p.isDefault)
    || compactProviders[0]
    || null;
  let credential = null;
  if (provider) {
    try {
      credential = await resolveProviderCredential({ provider, llmConfigStore });
    } catch (error) {
      console.warn('[main] compact credential unavailable:', error?.code || error?.message || error);
    }
  }
  const systemContext = buildSystemContext(workspacePath, {
    conversationId,
    continuityContext: priorContinuityContext,
    mode: 'compact',
    provider: provider?.provider ?? null,
    model: provider?.model ?? null,
  });
  const systemPrompt = renderSystemContext(systemContext);
  try {
    promptSnapshotStore.record(systemContext, {
      streamId,
      conversationId,
      contextEpochId: getActiveContextEpochId(conversationId),
      provider: provider?.provider ?? null,
      providerId: provider?.id ?? null,
      model: provider?.model ?? null,
      mode: 'compact',
    });
  } catch (error) {
    console.warn('[main] failed to record compact prompt snapshot:', error?.message || error);
  }

  let providerConfig = null;
  let resolvedChannel = null;
  if (provider && credential?.apiKey) {
    resolvedChannel = resolveChannel({
      ...provider,
      apiKey: credential.apiKey,
      accountId: credential.accountId,
    });
    providerConfig = {
      provider: resolvedChannel.legacyProvider,
      baseUrl: resolvedChannel.baseUrl,
      apiKey: credential.apiKey,
      model: provider.model,
      authMethod: credential.authMethod,
      accountId: credential.accountId,
      wire: resolvedChannel.wire,
      endpoint: resolvedChannel.endpoint,
      headers: resolvedChannel.headers,
      omitMaxOutputTokens: credential.authMethod === 'oauth_chatgpt',
    };
  }
  const contextWindow = provider?.contextWindow || 0;
  let tools = null;
  try {
    tools = buildRuntimeTools({
      mcpRegistry,
      providerType: provider?.provider === 'anthropic' ? 'anthropic' : 'openai',
      mode: conv.mode || 'chat',
    }).tools;
  } catch (error) {
    console.warn('[main] compact tool projection unavailable:', error?.message || error);
  }

  const apiMessages = [
    { role: 'system', content: systemPrompt },
    ...toDesktopProviderMessages(canonicalHistory.messages),
  ];

  // 登记表/横幅/进度/持久化/完成事件全部收敛到 runCompactionCheck 单入口（manual 语义）：
  // 手动 /compact = force 全量压缩 + 强制横幅；不再在 handler 内复制平行实现。
  // 见 knowledge/architecture/23-compaction-path-root-governance.md（单闸门不变式）。
  try {
    const exactAnthropic = resolvedChannel?.wire === 'anthropic-messages'
      && Boolean(credential?.apiKey);
    const exactGemini = resolvedChannel?.wire === 'gemini'
      && credential?.authMethod === 'api_key'
      && Boolean(credential?.apiKey);
    let outcome = null;
    const accountingPipeline = createContextAccountingCompactionPipeline({
      identity: {
        conversationId,
        contentRevision: Number.isSafeInteger(conv.contentRevision)
          ? conv.contentRevision + 1
          : 1,
        modelKey: contextAccountingModelKey(provider?.id, provider?.model),
      },
      contextWindow,
      countCapability: exactAnthropic || exactGemini
        ? { kind: 'provider_count_api' }
        : { kind: 'observed_usage_only' },
      initialSnapshot: reprojectContextAccountingWindow(
        conv.contextSnapshot?.version === 1
        && conv.contextSnapshot.modelKey === contextAccountingModelKey(provider?.id, provider?.model)
          ? conv.contextSnapshot
          : null,
        provider?.contextWindow,
      ),
      buildRequest(state) {
        if (exactAnthropic) {
          const system = state.messages
            .filter((message) => message.role === 'system')
            .map((message) => message.content)
            .join('\n\n');
          return {
            model: provider.model,
            system,
            messages: state.messages.filter((message) => message.role !== 'system'),
            tools,
            effort: conv.effort || 'default',
            supportsReasoning: Boolean(provider.supportsReasoning),
            promptCaching: provider.supportsPromptCaching !== false,
            maxOutputTokens: provider.maxOutputTokens || 0,
          };
        }
        return {
          model: provider?.model || '',
          messages: state.messages,
          tools,
          maxOutputTokens: provider?.maxOutputTokens || 0,
        };
      },
      countRequest: exactAnthropic
        ? (request) => countAnthropicCanonicalRequest({
            baseUrl: provider.baseUrl,
            apiKey: credential.apiKey,
            headers: resolvedChannel?.headers,
            ...request,
          })
        : exactGemini
          ? (request) => countGeminiCanonicalRequest({
              baseUrl: provider.baseUrl,
              apiKey: credential.apiKey,
              headers: resolvedChannel?.headers,
              ...request,
            })
          : undefined,
      async compact({ state }) {
        outcome = await runCompactionCheck({
          messages: state.messages,
          systemPrompt,
          contextWindow,
          providerConfig,
          // 手动路径的持久化需要用 Projector 分界后的 raw rows 作为源切片。
          persistCompaction: (args) => persistCompactionToConversation({
            ...args,
            sourceMessages: activeSourceMessages,
          }),
          conversationId,
          streamId,
          webContents: sender,
          force: true,
          manual: true,
          preserveLatestUserTurn: false,
          continuityContext: priorContinuityContext,
        });
        return {
          compacted: Boolean(outcome?.compacted),
          state: {
            messages: Array.isArray(outcome?.messages)
              ? outcome.messages
              : state.messages,
          },
        };
      },
      send: async () => {
        throw new Error('manual_compact_must_not_send');
      },
      onSnapshot(snapshot) {
        emitRuntimeEvent({
          type: 'context.accounting',
          sessionId: conversationId,
          conversationId,
          streamId,
          snapshot,
        });
      },
    });
    const accountingResult = await accountingPipeline.execute({
      state: { messages: apiMessages },
      command: 'manual_compact',
    });
    if (accountingResult.snapshot.version === 1) {
      conversationStore.updateContextSnapshot(
        conversationId,
        accountingResult.snapshot,
      );
    }
    if (!outcome?.compacted) return { compacted: false };

    const result = outcome.compactResult;
    try {
      const baselineContext = buildSystemContext(workspacePath, {
        conversationId,
        continuityContext: continuityContextFromCompactionResult(result),
        mode: 'chat',
        provider: provider?.provider ?? null,
        model: provider?.model ?? null,
      });
      promptSnapshotStore.recordBaseline(baselineContext, {
        streamId,
        conversationId,
        provider: provider?.provider ?? null,
        providerId: provider?.id ?? null,
        model: provider?.model ?? null,
        mode: 'chat',
        baselineReason: 'manual_compact',
      });
    } catch (error) {
      console.warn('[main] failed to record compact baseline:', error?.message || error);
    }

    // done 事件已由 coordinator 统一发出（含 manual 标记与压缩后投影）；这里只回 IPC 结果。
    return { compacted: true, notification: result.notification };
  } catch (error) {
    // 横幅收尾（idle）已由 coordinator 的 settleBannerIdle 处理，这里只上报错误。
    throw error;
  }
}

// ── 压缩态查询（按 conversationId）──
// 渲染层切会话时由 chat-ipc owner 查询主进程登记表，渲染层只负责表达。

// ── restored 重投影(21 号文档 13.3 / 23 号治理文档 Phase 1.4)──
// 会话打开时若持久化快照缺失/失效/来自其他宿主(source ≠ desktop),renderer 调此处
// 按当前宿主的完整成分(全量 system context + 模式投影工具 schema + active 历史)重算投影,
// 而不是用缺成分的本地估算兜底(那正是历史上 RC1 失准的根源)。
// 重算成功后回写 contextSnapshot(source: desktop),下次打开直接命中。
async function handleChatContextRestored(
  { conversationId, modelProviderId = null } = {},
) {
  const conv = conversationStore.getConversation(conversationId);
  if (!conv || !conv.messages?.length) return null;

  // 同一会话存在两条真实请求路径、组成不同(ADR 42 口径分离):
  // - 用户直接发送(chat send):renderer 富口径——segments 历史事实 + 附件;
  // - Goal Runner tick:瘦口径——裸文本历史 + tick 指令,连续性走 system 摘要。
  // restored 必须按「下一次实际会走哪条路」选口径,否则 goal 会话打开值与 tick 运行值
  // 互相跳变(曾现象:idle 4% → tick 运行 2%,两个数各自都真,但口径不连续)。
  const conversationPlans = typeof goalPlanStore?.listPlansByConversation === 'function'
    ? goalPlanStore.listPlansByConversation(conversationId)
    : [];
  const runningPlan = conversationPlans.find((plan) => plan?.runner?.status === 'running') ?? null;
  const canonicalHistory = projectConversationHistory(conv.messages);
  const activeMessages = runningPlan
    ? [
        ...canonicalHistory.messages,
        { role: 'user', content: buildGoalRunnerMessage(runningPlan, (runningPlan.runner?.roundCount ?? 0) + 1) },
      ]
    : canonicalHistory.messages;
  if (activeMessages.length === 0) return null;
  const continuityContext = desktopContinuityContextFromProjection(canonicalHistory);

  const providers = llmConfigStore.listProviders().filter((p) => p.apiKeyConfigured);
  const provider = (modelProviderId && providers.find((p) => p.id === modelProviderId))
    || (conv.modelProviderId && providers.find((p) => p.id === conv.modelProviderId))
    || providers.find((p) => p.isDefault)
    || providers[0]
    || null;
  const workspacePath = conv.workspacePath || settingsStore.getAll().activeWorkspace || null;
  const mode = typeof conv.mode === 'string' && conv.mode ? conv.mode : 'chat';

  const systemContext = buildSystemContext(workspacePath, {
    conversationId,
    continuityContext,
    mode,
    provider: provider?.provider ?? null,
    model: provider?.model ?? null,
    // 与真实发送的 buildSystemContext 尽量同成分(goal-plan / mcp-host source 在
    // goal 模式下占比最大);renderer 侧的 configInstructions/附件元数据为小头,缺失可接受。
    goalPlanStore,
    mcpRegistry,
  });
  const systemPrompt = renderSystemContext(systemContext);
  let tools = null;
  try {
    tools = buildRuntimeTools({
      mcpRegistry,
      providerType: provider?.provider === 'anthropic' ? 'anthropic' : 'openai',
      mode,
    }).tools;
  } catch (error) {
    // 工具投影失败时仍可给出 system+messages 投影,但降级为部分成分;记录以便排查。
    console.warn('[main] restored projection tools unavailable:', error?.message || error);
  }

  const projectedMessages = applyMicrocompaction(
    [{ role: 'system', content: systemPrompt }, ...activeMessages],
    { log: () => {} },
  ).messages;
  const identity = {
    conversationId,
    contentRevision: Number.isSafeInteger(conv.contentRevision)
      ? conv.contentRevision
      : 0,
    modelKey: contextAccountingModelKey(provider?.id, provider?.model),
  };
  const resolvedChannel = provider ? resolveChannel(provider) : null;
  let credential = null;
  try {
    credential = provider
      ? await resolveProviderCredential({ provider, llmConfigStore })
      : null;
  } catch {
    credential = null;
  }
  const exactAnthropic = resolvedChannel?.wire === 'anthropic-messages'
    && Boolean(credential?.apiKey);
  const exactGemini = resolvedChannel?.wire === 'gemini'
    && credential?.authMethod === 'api_key'
    && Boolean(credential?.apiKey);
  const countCapability = exactAnthropic || exactGemini
    ? { kind: 'provider_count_api' }
    : { kind: 'observed_usage_only' };
  let snapshot;
  if (exactAnthropic || exactGemini) {
    const canonicalRequest = exactAnthropic
      ? {
          model: provider.model,
          system: systemPrompt,
          messages: projectedMessages.filter((message) => message.role !== 'system'),
          tools,
          effort: conv.effort || 'default',
          supportsReasoning: Boolean(provider.supportsReasoning),
          promptCaching: provider.supportsPromptCaching !== false,
          maxOutputTokens: provider.maxOutputTokens || 0,
        }
      : {
          model: provider.model,
          messages: projectedMessages,
          tools,
          maxOutputTokens: provider.maxOutputTokens || 0,
        };
    const pipeline = createContextAccountingCompactionPipeline({
      identity,
      contextWindow: provider.contextWindow || null,
      countCapability,
      initialSnapshot: reprojectContextAccountingWindow(
        conv.contextSnapshot?.version === 1
        && conv.contextSnapshot.modelKey === identity.modelKey
          ? conv.contextSnapshot
          : null,
        provider?.contextWindow,
      ),
      buildRequest: () => canonicalRequest,
      countRequest: exactAnthropic
        ? (request) => countAnthropicCanonicalRequest({
            baseUrl: provider.baseUrl,
            apiKey: credential.apiKey,
            headers: resolvedChannel?.headers,
            ...request,
          })
        : (request) => countGeminiCanonicalRequest({
            baseUrl: provider.baseUrl,
            apiKey: credential.apiKey,
            headers: resolvedChannel?.headers,
            ...request,
          }),
      compact: ({ state }) => ({ compacted: false, state }),
      send: async () => {
        throw new Error('restored_count_only_must_not_send');
      },
    });
    snapshot = (await pipeline.execute({
      state: null,
      command: 'count_only',
    })).snapshot;
  } else {
    const restoredUsage = conversationStore.getLatestContextObservation?.(
      conversationId,
      { modelKey: identity.modelKey },
    );
    snapshot = restoredUsage
      ? createRestoredObservedContextAccountingSnapshot({
          identity,
          contextWindow: provider?.contextWindow || null,
          countCapability,
          usage: restoredUsage,
          revision: conv.contextSnapshot?.revision ?? 0,
          compactionEpoch: restoredUsage.compactionEpoch,
          pendingUncountedChanges: activeMessages.length > 0,
        })
      : createUnknownContextAccountingSnapshot({
          identity,
          contextWindow: provider?.contextWindow || null,
          countCapability,
          phase: 'restored',
          revision: conv.contextSnapshot?.revision ?? 0,
          compactionEpoch: conv.contextSnapshot?.compactionEpoch ?? 0,
          pendingUncountedChanges: activeMessages.length > 0,
        });
  }
  try {
    // 守卫:unknown 快照不得覆盖 sidecar 里已有的 provider_usage 观测快照。
    // 否则「重启 → restore 无 observation → unknown 落盘」会永久抹掉圆环基线。
    const existing = conv.contextSnapshot;
    const wouldClobberObserved =
      snapshot?.pressureSource === 'unknown'
      && existing?.version === 1
      && existing.pressureSource === 'provider_usage'
      && existing.modelKey === snapshot.modelKey;
    if (!wouldClobberObserved) {
      conversationStore.updateContextSnapshot(conversationId, snapshot);
    }
  } catch (error) {
    console.warn('[main] failed to persist restored projection:', error?.message || error);
  }
  return snapshot;
}

// ── Local Tool Host ──
const pendingRuntimeEvents = [];

function forwardRuntimeEvent(event) {
  broadcastToAllWindows('runtime:event', event);
}

function emitRuntimeEvent(event) {
  if (localToolHost?.runtime) {
    return localToolHost.runtime.emit(event);
  }
  pendingRuntimeEvents.push(event);
  return null;
}

function flushPendingRuntimeEvents() {
  if (!localToolHost?.runtime || pendingRuntimeEvents.length === 0) return;
  for (const event of pendingRuntimeEvents.splice(0)) {
    localToolHost.runtime.emit(event);
  }
}

async function startRecoveryAndAppearance() {
  // Milestone C: 进程重启后扫描 interrupted Goal compaction/resume 状态。
  // 必须在 UI/IPC 就绪前尽早 kick，避免用户打开会话前 runner 一直挂着。
  try {
    if (goalRunner && typeof goalRunner.recoverContextCheckpoints === 'function') {
      const recovery = goalRunner.recoverContextCheckpoints();
      if (recovery?.recovered?.length) {
        console.info(
          `[main] recovered ${recovery.recovered.length}/${recovery.scanned} goal checkpoint(s) after startup`,
        );
      }
    }
  } catch (error) {
    console.error('[main] recoverContextCheckpoints failed:', error?.message || error);
  }
  setDockIcon();
  const onNativeThemeUpdated = () => {
    const appearance = settingsStore.getAll().appearance;
    if (appearance?.mode !== 'system') return;
    setDockIcon(appearance);
    quickChatWindowController.getWindow()?.webContents.send('appearance:changed', appearance);
  };
  nativeTheme.on('updated', onNativeThemeUpdated);
  return {
    name: 'native-theme-listener',
    dispose: () => nativeTheme.removeListener('updated', onNativeThemeUpdated),
  };
}

function startLocalRuntime() {
  const userDataPath = dataHome;
  // skillStore 已在模块初始化阶段创建（供 chat tool projection 使用）。
  // 这里只挂 marketplace，并把当前 workspace 再同步一次。
  skillStore?.setWorkspacePath?.(settingsStore.getAll().activeWorkspace || null);
  skillMarketplaceService = createSkillMarketplaceService({
    catalogRoot: isPackaged ? path.join(process.resourcesPath, 'marketplace') : path.join(workspaceRoot, 'marketplace', 'dist'),
    installSkillFromZip: (zipBuffer) => skillStore.installSkillFromZip(zipBuffer),
  });
  const skillHubApiClient = createSkillHubApiClient();
  const skillHubStore = createSkillHubMarketplaceStore({
    filePath: path.join(userDataPath, 'marketplace', 'skillhub-index.json'),
    apiClient: skillHubApiClient,
  });
  const skillHubInstaller = createSkillHubVerifiedInstaller({
    apiClient: skillHubApiClient,
    installSkillFromZip: (zipBuffer, options) => skillStore.installSkillFromZip(zipBuffer, options),
  });
  skillHubMarketplaceService = createSkillHubMarketplaceService({
    store: skillHubStore,
    installer: skillHubInstaller,
    apiClient: skillHubApiClient,
  });
  // 全量元数据同步属于主进程本地能力：启动后在后台从 checkpoint 续传，
  // 不阻塞首帧，也不把同步生命周期交给 Renderer 页面是否被打开。
  const skillHubSyncStatus = skillHubMarketplaceService.getStatus();
  const skillHubIndexStale = !skillHubSyncStatus.updatedAt || Date.now() - skillHubSyncStatus.updatedAt > 24 * 60 * 60 * 1_000;
  if (skillHubSyncStatus.status === 'error' || skillHubSyncStatus.nextPage > 1 || skillHubIndexStale) {
    void skillHubMarketplaceService.sync().catch((error) => {
      console.warn('[skillhub] Background marketplace sync paused:', error instanceof Error ? error.message : error);
    });
  }

  const shellProvider = createLocalShellProvider({
    workspaceRoot: resourcesRoot,
    userDataPath,
  });

  localToolHost = createLocalToolHost({
    workspaceRoot: resourcesRoot,
    userDataPath,
    sessionStore,
    mcpRegistry,
    mcpCredentialResolver,
    shellProvider,
    automationProposalService,
    // 让 AI 工具路径（goal_create_plan / goal_update_task）与 IPC 路径共享同一个
    // goalPlanStore 实例，避免出现"两个实例指向同磁盘、需重挂载才同步"的 bug。
    goalProvider: createLocalGoalProvider({ goalPlanStore }),
    ensureBrowserReady: browserPanelRevealCoordinator.ensureBrowserReady,
    extraProviders: skillStore ? [createLocalSkillProvider({ skillStore })] : [],
    onRuntimeEvent: forwardRuntimeEvent,
  });
  flushPendingRuntimeEvents();
  return {
    name: 'local-tool-host-events',
    dispose: () => {
      localToolHost?.unsubscribeRuntimeEvents?.();
      localToolHost = null;
    },
  };
}

function startDesktopAffordances() {
  const owner = {
    name: 'desktop-affordances',
    dispose: () => {
      const failures = [];
      for (const dispose of [
        () => stopAutoUpdater(),
        () => shortcutService.dispose(),
        () => trayController?.destroy?.(),
        () => quickChatWindowController.destroy(),
      ]) {
        try {
          dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      trayController = null;
      taskNotificationBroker = null;
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Desktop affordances cleanup failed');
      }
    },
  };

  try {
    // 菜单栏托盘：Recent 会话 + New Chat / Open / Quit（P0 原生 Menu）。
  try {
    trayController = createAppTrayController();
  } catch (err) {
    console.warn('[tray] init failed:', err);
    trayController = null;
  }

  // 任务完成系统通知 Broker：订阅 goalPlans 变更、去重、前台抑制、点击回流。
  try {
    taskNotificationBroker = createTaskNotificationBroker({
      getPlan: (planId) => goalPlanStore.getPlan(planId),
      listPlans: () => goalPlanStore.listPlanDetails(),
      getSettings: () => settingsStore.getAll(),
      isAppForeground: () => isMainAppForegroundForNotifications(),
      getActiveConversationId: () =>
        conversationSessionApplicationService.getActiveConversationId(),
      openConversation: (payload) => openConversationFromTaskNotification(payload),
      showNotification: (payload) => showTaskSystemNotification(payload),
      isNotificationSupported: () => Notification.isSupported(),
      logWarn: (message, err) => console.warn(message, err),
    });
    taskNotificationBroker.bootstrapExisting();
  } catch (err) {
    console.warn('[task-notification] broker init failed:', err);
    taskNotificationBroker = null;
  }

  // 启动后预热 Quick 窗口（隐藏态创建 + 加载 renderer），避免首次快捷键唤醒冷创建。
  try {
    quickChatWindowController.prewarm();
  } catch (err) {
    console.warn('[quick-chat] prewarm failed:', err);
  }
  const shortcutRegistration = shortcutService.register();
  if (!shortcutRegistration.success) {
    console.warn('[shortcuts] Quick Chat global shortcut unavailable:', shortcutRegistration.error);
  }
  // Drop any previously persisted Appshot accelerator so it cannot re-occupy ⌘⇧A
  // after the double-⌘ deferral (user decision 2026-07-30).
  try {
    const shortcuts = settingsStore.getAll().shortcuts;
    if (shortcuts && typeof shortcuts === 'object' && shortcuts.appshot) {
      const { appshot: _removed, ...rest } = shortcuts;
      settingsStore.merge({ shortcuts: rest });
    }
  } catch (err) {
    console.warn('[appshot] failed to clear persisted appshot shortcut:', err?.message ?? err);
  }

  // Appshots T3.1: absorb the one-time window-list binary compile + first-exec
  // security scan at startup (still useful for settings-test capture latency).
  void appshotService.warmup();

  // 自定义应用菜单替换 Electron 默认菜单：移除生产环境整窗 Reload/Force Reload，
  // ⌘R 收归为「刷新内嵌浏览器页」（初始无活动浏览器页时置灰）。
  rebuildAppMenu();

  // 自动更新：通道按「设置项优先，回退版本号语义」解析（beta / stable）。
  // 渲染层负责表达（版本徽标红点 / 摘要弹窗 / 进度条），事件经 updater:event 广播。
  // 开发态默认跳过，可用 PEER_AGENT_FORCE_UPDATER=1 强制联调。
  try {
    initAutoUpdater({
      getPreference: () => settingsStore.getAll().updateChannel,
      onEvent: (event) => broadcastToAllWindows('updater:event', event),
    });
  } catch (err) {
    console.error('[updater] init failed:', err);
  }

    return owner;
  } catch (error) {
    try {
      owner.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Desktop affordances startup and rollback both failed',
      );
    }
    throw error;
  }
}

function startBackgroundWork() {
  // 首窗和 IPC ready 后再启动非关键后台工作；失败只降级，不影响 Desktop 可用性。
  void providerConfigurationApplicationService.scheduleMissingPricingBackfill('startup');
  void createShellEnvSnapshot().catch((err) => {
    console.warn('[shell-env-snapshot] background create failed:', err?.message || err);
  });
}

function startAutomationRuntime() {
  const worktreeAdapter = createAutomationWorktreeAdapter();
  const outcomeController = createAutomationOutcomeController({
    store: automationStore,
    createNotification: (options) => new Notification(options),
    openRun: openAutomationRunFromNotification,
    logger: console,
  });
  automationRunner = createAutomationRunner({
    store: automationStore,
    conversationStore,
    llmChatService,
    worktreeAdapter,
    onBackgroundEvent: ({ channel, payload }) => broadcastToAllWindows(channel, payload),
    onRunUpdated: (run) => outcomeController.handleRunUpdated(run),
    logger: console,
  });
  automationRuntimeOwner = createAutomationRuntimeOwner({
    store: automationStore,
    powerMonitor,
    onRunReady: (run) => {
      void automationRunner.run(run).catch((error) => {
        console.error('[automation-runtime] runner failed:', error);
      });
    },
    scheduleTimer: (callback, delay) => setTimeout(callback, delay),
    cancelTimer: (timer) => clearTimeout(timer),
    logger: console,
  });
  automationRuntimeOwner.start();
  return {
    dispose: () => {
      automationRuntimeOwner?.dispose();
      automationRuntimeOwner = null;
      automationRunner = null;
    },
  };
}

const desktopCompositionRoot = createDesktopCompositionRoot({
  logger: console,
  initialOwners: [
    { name: 'conversation-change-subscription', dispose: stopConversationChangeSubscription },
    { name: 'goal-plan-change-subscription', dispose: stopGoalPlanChangeSubscription },
    { name: 'mcp-oauth-callback', dispose: closeMcpOAuthCallback },
    { name: 'catalog-ipc-main', dispose: () => ipcMain.dispose() },
    { name: 'trusted-window-registry', dispose: () => trustedWindowRegistry.dispose() },
    { name: 'full-disk-access-drag-float', dispose: () => fullDiskAccessDragFloatController.destroy() },
  ],
  phases: [
    { name: 'recovery-and-appearance', start: startRecoveryAndAppearance },
    { name: 'local-runtime', start: startLocalRuntime },
    { name: 'desktop-ipc', start: () => registerDesktopIpcHost() },
    {
      name: 'first-main-window',
      start: () => {
        const mainWindow = createWindow();
        return {
          name: 'first-main-window',
          dispose: () => {
            if (!mainWindow.isDestroyed()) mainWindow.close();
          },
        };
      },
    },
    { name: 'desktop-affordances', optional: true, start: startDesktopAffordances },
    { name: 'automation-runtime', optional: true, start: startAutomationRuntime },
    { name: 'background-work', optional: true, start: startBackgroundWork },
  ],
});

desktopLifecycleBinding = bindDesktopAppLifecycle({
  app,
  root: desktopCompositionRoot,
  platform: process.platform,
  logger: console,
  onActivate: () => {
    // Quick Chat 等隐藏窗口不能代表主窗口存在；按主窗口角色决定唤起或重建。
    showOrCreateMainWindow();
  },
  onFatalStartupError: (error) => {
    console.error('[main] desktop composition startup failed:', error);
  },
});
