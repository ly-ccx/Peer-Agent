import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, webContents } from 'electron';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);
import { createCapabilityRegistry } from './capability-registry.mjs';
import { loadLocalEnv } from './env-loader.mjs';
import { readProjectIndex } from './project-index.mjs';
import { createSessionStore, resolveLocalAccessLevel } from './session-store.mjs';
import { createLocalToolHost } from './runtime-gateway/local-tool-host.mjs';
import {
  registerBrowserWebContents,
  unregisterBrowserWebContents,
  getActiveWebContentsId,
} from './runtime-gateway/browser-control-registry.mjs';
import { buildAppMenu } from './app-menu.mjs';
import { createLocalShellProvider } from './runtime-gateway/local-shell-provider.mjs';
import { createLocalSkillProvider } from './runtime-gateway/local-skill-provider.mjs';
import { createSkillStore } from './skill-store.mjs';
import { createShellEnvSnapshot } from './runtime-gateway/shell-env-snapshot.mjs';
import { getDataHome, migrateFromLegacy, exportBundle, importBundle } from './data-store.mjs';
import { createSettingsStore } from './settings-store.mjs';
import { createShortcutService } from './shortcut-service.mjs';
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
import { collectUsageDaily } from './usage-daily.mjs';
import { listChannelDescriptors, resolveChannel } from './provider-channels.mjs';
import { startBrowserLogin, ensureFreshTokens } from './llm-oauth/openai-oauth.mjs';
import { startGoogleBrowserLogin, ensureFreshGoogleTokens } from './llm-oauth/google-oauth.mjs';
import { startGrokOAuthLogin, ensureFreshGrokTokens } from './llm-oauth/grok-oauth.mjs';
import { fetchWithConnectionRecovery } from './provider-transports/recovering-fetch.mjs';
import { listSubscriptionModels, listOpenAICompatibleModels } from './provider-adapters/openai-model-catalog.mjs';
import { listGrokBuildModels } from './provider-adapters/grok-build-model-catalog.mjs';
import { listGeminiModels, preferGeminiModel } from './provider-adapters/gemini-model-catalog.mjs';
import { listQoderModels } from './provider-adapters/qoder-model-catalog.mjs';
import { createHostRestarter } from './host-restart.mjs';
import { resolveDockIconPaths } from './dock-icon-paths.mjs';
import { clearPendingTask, peekPendingTask, readAndClearPendingTask, writePendingTask } from './pending-task-store.mjs';
import { buildRuntimeTools, createLlmChatService } from './llm-chat-service.mjs';
import { removeConversationToolArtifacts } from '@peer-agent/runtime-node';
import {
  CANONICAL_HISTORY_PROJECTOR_VERSION,
  createContextProjectionLifecycle,
  projectConversationHistory,
} from '@peer-agent/runtime-core';
import { buildSystemContext, renderSystemContext } from './llm-prompts.mjs';
import { createContextBaselineRecorder } from './prompt/context-baseline-recorder.mjs';
import { createPromptSnapshotStore } from './prompt/prompt-snapshot-store.mjs';
import { createConversationStore } from './conversation-store.mjs';
import { resolveConversationModelProviderId } from './conversation-model-binding.mjs';
import { createGoalPlanStore, goalPlanIsSelfDriven } from './goal-plan-store.mjs';
import { bindExternalGoalPlanChanges } from './goal-plan-change-bridge.mjs';
import {
  decideIntakeConvergence,
  serializeAcceptedGoalRunnerHandoff,
  shouldAutoStartAcceptedGoalRunner,
  shouldAutoStartAcceptedGoalRunnerFromChange,
  shouldRecoverAcceptedGoalRunnerOnConversationOpen,
} from './goal-intake-convergence.mjs';
import { createGoalRunner } from './goal-runner.mjs';
import { createTaskNotificationBroker } from './task-notification-broker.mjs';
import {
  buildGoalRunnerStreamStartedPayload,
  createGoalRunnerAssistantPlaceholder,
} from './goal-runner-message-persistence.mjs';
import { fetchProviderSubscriptionQuota, resolveGeminiCodeAssistProjectId } from './subscription-quota.mjs';
import { applyGoalMessageRoute, routeGoalMessage } from './goal-message-router.mjs';
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

function setDockIcon(appearance = settingsStore.getAll().appearance) {
  // app.dock.setIcon renders a PNG as-is in both development and packaged apps,
  // so the shipped theme variants already include their macOS alpha mask.
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

let skillStore;

const mcpRegistry = createMcpRegistry();
const mcpCredentialStore = createMcpCredentialStore();
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

function createMcpProbeResponse(probe, view) {
  return {
    ...probe,
    success: probe.state === 'connected',
    toolCount: probe.toolsCount,
    view,
  };
}

function persistMcpProbeResult(serverId, probe) {
  if (probe.state === 'connected' && probe.manifest) return mcpRegistry.updateManifest(serverId, probe.manifest);
  return mcpRegistry.updateHealth(serverId, probe.health);
}

const llmConfigStore = createLlmConfigStore();
const conversationStore = createConversationStore();
const stopConversationChangeSubscription = conversationStore.subscribeChanges((event) => {
  if (event.writerPid === process.pid) return;

  const workspacePath = typeof event.workspacePath === 'string' ? event.workspacePath : null;
  if (workspacePath && existsSync(workspacePath)) {
    broadcastToAllWindows('workspaces:changed', { workspacePath });
  }

  broadcastToAllWindows('conversations:changed', event);
});
// 主窗口当前前台会话（由 renderer 通过 conversation:set-active 上报），用于同会话通知抑制。
let activeConversationIdForNotifications = null;

const goalPlanStore = createGoalPlanStore({
  // 任何写路径（IPC 或 AI 工具 local-goal-provider）改动计划后，广播给所有窗口，
  // 让 GoalPlanPanel 实时重拉，无需切换会话/重挂载。详见方案 B。
  // broadcastToAllWindows 是后文的函数声明（已提升），onChange 仅在运行时触发，引用安全。
  onChange: (payload) => {
    broadcastToAllWindows('goalPlans:changed', payload);
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
let taskNotificationBroker = null;
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

function providerPromptTargetChanged(before = null, after = null) {
  if (!after?.isDefault) return false;
  if (!before) return true;
  return before.provider !== after.provider || before.model !== after.model;
}

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
  requestProjection = null,
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
    requestProjection,
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
  const mainWindow = getPeerAgentMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (conversationId) {
      mainWindow.webContents.send('quick-chat:open-conversation', {
        conversationId,
        workspacePath,
        planId: payload.planId ?? payload.taskId ?? null,
        messageId: typeof payload.messageId === 'string' ? payload.messageId : null,
        attentionVersion: payload.attentionVersion ?? null,
        source: payload.source || 'system-notification',
      });
    }
    return true;
  }
  // 主窗口不存在时先创建，再在 did-finish-load 后发送（简化：创建后立即 send，renderer 会挂 listener）
  createWindow();
  const created = getPeerAgentMainWindow();
  if (created && !created.isDestroyed() && conversationId) {
    created.webContents.once('did-finish-load', () => {
      created.webContents.send('quick-chat:open-conversation', {
        conversationId,
        workspacePath,
        planId: payload.planId ?? payload.taskId ?? null,
        messageId: typeof payload.messageId === 'string' ? payload.messageId : null,
        attentionVersion: payload.attentionVersion ?? null,
        source: payload.source || 'system-notification',
      });
    });
    return true;
  }
  return false;
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
  // 注入带 onChange 的同一 goalPlanStore 单例，使 AI 工具写计划经唯一写路径广播，
  // 浮条无需切会话即可随流式更新。见 Goal 模式设计。
  goalPlanStore,
  broadcast: broadcastToAllWindows,
});
llmChatService.setWorkspacePath(settingsStore.getAll().activeWorkspace || null);

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

function loadRendererWindow(targetWindow, query = {}) {
  if (isDev) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
    void targetWindow.loadURL(url.toString());
  } else {
    const indexPath = isPackaged
      ? path.join(__dirname, '../../dist/index.html')
      : path.join(workspaceRoot, 'apps/desktop/dist/index.html');
    void targetWindow.loadFile(indexPath, { query });
  }
}

function createQuickChatWindow() {
  const quickWindow = new BrowserWindow({
    ...QUICK_CHAT_SIZE,
    minWidth: QUICK_CHAT_SIZE.width,
    maxWidth: QUICK_CHAT_SIZE.width,
    minHeight: QUICK_CHAT_SIZE.height,
    useContentSize: true,
    backgroundColor: '#00000000',
    transparent: true,
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
  loadRendererWindow(quickWindow, { window: 'quick-chat' });
  return quickWindow;
}

const quickChatWindowController = createQuickChatWindowController({
  screen,
  createWindow: createQuickChatWindow,
});
const shortcutService = createShortcutService({
  globalShortcut,
  settingsStore,
  onQuickChat: () => quickChatWindowController.toggle(),
});

ipcMain.handle('shortcuts:status', () => shortcutService.status());
ipcMain.handle('shortcuts:update', (_event, actionOrAccelerator, accelerator) =>
  shortcutService.update(actionOrAccelerator, accelerator));
ipcMain.handle('shortcuts:reset', (_event, action) => shortcutService.reset(action));

ipcMain.handle('quick-chat:hide', () => {
  quickChatWindowController.hide();
  return { ok: true };
});
ipcMain.handle('quick-chat-popover:show', (_event, payload = {}) => ({
  ok: quickChatWindowController.showPopover(payload),
}));
ipcMain.handle('quick-chat:set-task-card-visible', (_event, payload = {}) => ({
  ok: quickChatWindowController.setTaskCardVisible(payload.visible === true),
}));
ipcMain.handle('quick-chat:set-content-height', (_event, payload = {}) => (
  quickChatWindowController.setContentHeight(payload?.height)
));
ipcMain.handle('quick-chat-popover:hide', () => {
  quickChatWindowController.hidePopover({ restoreFocus: true });
  return { ok: true };
});
ipcMain.handle('quick-chat-popover:select', (_event, value) => ({
  ok: quickChatWindowController.selectPopoverValue(value),
}));
ipcMain.handle('quick-chat:submit', (_event, payload = {}) => {
  quickChatWindowController.hide();
  const mainWindow = getPeerAgentMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('quick-chat:conversation-created', payload);
    if (payload.openMainWindow) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('quick-chat:open-conversation', payload);
    }
  }
  return { ok: true };
});

// renderer 上报当前前台会话，供任务系统通知做「同会话抑制」。
ipcMain.handle('conversation:set-active', (_event, payload = {}) => {
  const conversationId =
    payload && typeof payload.conversationId === 'string' && payload.conversationId.trim()
      ? payload.conversationId.trim()
      : null;
  activeConversationIdForNotifications = conversationId;
  if (conversationId) {
    const activeGoal = goalPlanStore.getActivePlanByConversation?.(conversationId) ?? null;
    if (shouldRecoverAcceptedGoalRunnerOnConversationOpen(activeGoal)) {
      // 主进程重载会丢失内存 session，但磁盘 runner 仍是 running。打开会话时
      // 幂等 kick 即可恢复；若 session 本就存在，Goal Runner.start 会直接 no-op。
      queueMicrotask(() => {
        void goalRunner?.start(activeGoal.planId).catch((error) => {
          console.error('[main] recover active goal runner failed:', error?.message || error);
        });
      });
    }
  }
  if (conversationId && taskNotificationBroker) {
    // 打开会话即视为已读该会话下当前 attention（若已知 planId 则精确标记）。
    const planId =
      payload && typeof payload.planId === 'string' && payload.planId.trim()
        ? payload.planId.trim()
        : null;
    if (planId) {
      try {
        taskNotificationBroker.markTaskRead(planId);
      } catch (err) {
        console.warn('[task-notification] markTaskRead failed:', err);
      }
    }
  }
  return { ok: true, conversationId: activeConversationIdForNotifications };
});

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
    backgroundColor: isMac ? '#00000000' : '#1e1e2e',
    ...(isMac
      ? {
          transparent: true,
          vibrancy: 'sidebar',
          visualEffectState: 'active',
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

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    const indexPath = isPackaged
      ? path.join(__dirname, '../../dist/index.html')
      : path.join(workspaceRoot, 'apps/desktop/dist/index.html');
    void mainWindow.loadFile(indexPath);
  }
}

// ── Bootstrap & Session ──
ipcMain.handle('bootstrap:get', async () => ({
  session: sessionStore.getSession(),
  capabilities: capabilityRegistry.refreshCapabilities(),
  // 冷启动：monorepo git 项目索引不阻塞 bootstrap；projects:list 仍可按需同步读取。
  projects: [],
  activeProjectId: 'workspace-root',
  availableLocales,
  llmProviders: llmConfigStore.listProviders(),
}));

ipcMain.handle('session:get', () => sessionStore.getSession());
ipcMain.handle('capabilities:list', () => capabilityRegistry.refreshCapabilities());
ipcMain.handle('projects:list', () => readProjectIndex({ workspaceRoot: resourcesRoot }));
ipcMain.handle('runtime-projection:get', () => buildRuntimeProjection());

// ── Updater ──
// 渲染层只表达；检查/下载/安装/通道切换都在主进程执行。
ipcMain.handle('updater:get-status', () => getUpdaterStatus());
ipcMain.handle('updater:check', async () => await checkForUpdates());
ipcMain.handle('updater:download', async () => await downloadUpdate());
ipcMain.handle('updater:install', () => {
  quitAndInstall();
});
ipcMain.handle('updater:open-installer', async () => await openInstaller());
ipcMain.handle('updater:open-release-page', async () => await openReleasePage());
ipcMain.handle('updater:set-channel', (_event, preference) => {
  // settings 是通道偏好的权限真相，先写回再切换运行时配置。
  const pref =
    preference === 'beta' || preference === 'stable' || preference === 'auto' ? preference : 'auto';
  settingsStore.merge({ updateChannel: pref });
  const status = setChannelPreference(pref);
  // 切换通道后用新通道重新检查一次（事件会经 updater:event 广播给渲染层）。
  void checkForUpdates();
  return status;
});

// ── Settings ──
ipcMain.handle('settings:get', () => settingsStore.getAll());
ipcMain.handle('settings:update', (_event, partial) => {
  const before = settingsStore.getAll();
  const next = settingsStore.merge(partial);
  if (
    partial
    && typeof partial === 'object'
    && !Array.isArray(partial)
    && Object.prototype.hasOwnProperty.call(partial, 'appearance')
  ) {
    const quickWindow = quickChatWindowController.getWindow();
    setDockIcon(next.appearance);
    quickWindow?.webContents.send('appearance:changed', next.appearance);
  }
  if (
    partial
    && typeof partial === 'object'
    && !Array.isArray(partial)
    && Object.prototype.hasOwnProperty.call(partial, 'systemInstructions')
    && normalizeSystemInstructions(before.systemInstructions) !== normalizeSystemInstructions(next.systemInstructions)
  ) {
    recordInstructionBaseline(next.systemInstructions);
  }
  if (
    partial
    && typeof partial === 'object'
    && !Array.isArray(partial)
    && Object.prototype.hasOwnProperty.call(partial, 'localAccessLevel')
  ) {
    const accessLevel = resolveLocalAccessLevel(next.localAccessLevel);
    sessionStore.setAccessLevel(accessLevel);
    llmChatService.setLocalAccessLevel(accessLevel);
    if (next.localAccessLevel !== accessLevel) {
      settingsStore.merge({ localAccessLevel: accessLevel });
      return { ...next, localAccessLevel: accessLevel };
    }
  }
  return next;
});

ipcMain.handle('developer-settings:get', () => settingsStore.getAll().developer ?? {});
ipcMain.handle('developer-settings:update', (_event, partial) => {
  const current = settingsStore.getAll().developer;
  const currentDeveloper = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const nextPartial = partial && typeof partial === 'object' && !Array.isArray(partial) ? partial : {};
  const next = { ...currentDeveloper, ...nextPartial };
  settingsStore.merge({ developer: next });
  return next;
});
ipcMain.handle('developer-settings:reset', () => {
  settingsStore.merge({ developer: {} });
  return {};
});
ipcMain.handle('developer-settings:diagnostics', () => ({
  dataHome,
  isDev,
  isPackaged,
  resourcesRoot,
  workspaceRoot,
  loadedEnvKeys,
}));

ipcMain.on('settings:get-sync', (event) => {
  event.returnValue = settingsStore.getAll();
});
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

// ── Locale ──
ipcMain.handle('locale:set', (_event, payload) => {
  sessionStore.setLocale(payload.locale);
  settingsStore.merge({ locale: payload.locale });
  rebuildAppMenu();
  return sessionStore.getSession();
});

// ── Permission ──
function createPermissionGrant({ toolCallId, granted, duration, scope }) {
  return {
    grantId: randomUUID(),
    toolCallId,
    granted,
    duration: granted ? (duration || 'once') : 'denied',
    scope: scope || 'client_session',
    decidedAt: new Date().toISOString(),
  };
}
ipcMain.handle('permission:approve', (_event, payload) => {
  const grant = createPermissionGrant({
    toolCallId: payload.toolCallId,
    granted: true,
    duration: payload.duration,
    scope: payload.scope,
  });
  llmChatService.resolvePermissionGrant(payload.toolCallId, grant);
  return grant;
});
ipcMain.handle('permission:deny', (_event, payload) => {
  const grant = createPermissionGrant({ toolCallId: payload.toolCallId, granted: false });
  llmChatService.resolvePermissionGrant(payload.toolCallId, grant);
  return grant;
});

// ── Workspace ──
ipcMain.handle('workspace:list', () => {
  const all = settingsStore.getAll();
  const configured = all.workspaces || [];
  const knownPaths = new Set(configured.map((workspace) => workspace.path));
  const discovered = conversationStore.listConversations({ includeMessageCount: false })
    .map((conversation) => conversation.workspacePath)
    .filter((workspacePath) => typeof workspacePath === 'string' && existsSync(workspacePath))
    .filter((workspacePath) => {
      if (knownPaths.has(workspacePath)) return false;
      knownPaths.add(workspacePath);
      return true;
    })
    .map((workspacePath) => ({
      path: workspacePath,
      name: path.basename(workspacePath),
      addedAt: new Date(0).toISOString(),
    }));
  return {
    workspaces: [...configured, ...discovered],
    activeWorkspace: all.activeWorkspace || null,
  };
});

ipcMain.handle('workspace:ensure-default', () => {
  const all = settingsStore.getAll();
  const workspaces = all.workspaces || [];
  // 已有 active 工作区：直接返回，不做任何事
  if (all.activeWorkspace && existsSync(all.activeWorkspace)) {
    return { path: all.activeWorkspace, name: path.basename(all.activeWorkspace), created: false };
  }
  // 没有 active：在用户主目录下初始化一个默认工作区
  const defaultDir = path.join(app.getPath('home'), 'PeerAgent');
  let created = false;
  if (!existsSync(defaultDir)) {
    mkdirSync(defaultDir, { recursive: true });
    created = true;
  }
  const name = path.basename(defaultDir);
  if (!workspaces.some((w) => w.path === defaultDir)) {
    workspaces.push({ path: defaultDir, name, addedAt: new Date().toISOString() });
  }
  settingsStore.merge({ workspaces, activeWorkspace: defaultDir });
  llmChatService.setWorkspacePath(defaultDir);
  return { path: defaultDir, name, created };
});

ipcMain.handle('workspace:add', async (event) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(
    BrowserWindow.fromWebContents(event.sender),
    { title: '选择项目目录', properties: ['openDirectory'] },
  );
  if (canceled || !filePaths?.[0]) return null;
  const dir = filePaths[0];
  const name = path.basename(dir);
  const all = settingsStore.getAll();
  const workspaces = all.workspaces || [];
  if (workspaces.some((w) => w.path === dir)) {
    settingsStore.merge({ activeWorkspace: dir });
    // 与 workspace:set-active 对齐：选中工作区后同步全局兜底态，避免「新增/选中后
    // 全局 activeWorkspacePath 滞后」导致兜底链取到旧值（运行根目录主真值已按会话解析，
    // 此处仅保证兜底一致性）。
    llmChatService.setWorkspacePath(dir);
    return { path: dir, name, existing: true };
  }
  workspaces.push({ path: dir, name, addedAt: new Date().toISOString() });
  settingsStore.merge({ workspaces, activeWorkspace: dir });
  llmChatService.setWorkspacePath(dir);
  return { path: dir, name, existing: false };
});

ipcMain.handle('workspace:set-active', (_, { path: wsPath }) => {
  settingsStore.merge({ activeWorkspace: wsPath || null });
  llmChatService.setWorkspacePath(wsPath || null);
  return { activeWorkspace: wsPath || null };
});

ipcMain.handle('workspace:remove', (_, { path: wsPath }) => {
  const all = settingsStore.getAll();
  const workspaces = (all.workspaces || []).filter((w) => w.path !== wsPath);
  const active = all.activeWorkspace === wsPath ? null : all.activeWorkspace;
  settingsStore.merge({ workspaces, activeWorkspace: active });
  return { workspaces, activeWorkspace: active };
});

ipcMain.handle('workspace:info', (_, { path: wsPath }) => {
  if (!wsPath) return null;
  return readProjectIndex({ workspaceRoot: wsPath })?.[0] || { name: path.basename(wsPath), absolutePath: wsPath };
});

// 打开渲染层点击的文件路径：优先用系统默认程序打开，失败回退到在文件管理器中定位。
// 入参 absPath 必须是绝对路径（相对路径由渲染层基于 workspacePath 解析后再传入）。
// 做基本的存在性校验；可选 workspaceRoot 用于越界校验，越界则拒绝。
ipcMain.handle('shell:open-path', async (_event, { absPath, workspaceRoot } = {}) => {
  try {
    if (!absPath || typeof absPath !== 'string') {
      return { ok: false, reason: 'invalid_path' };
    }
    const target = path.normalize(absPath);
    if (!path.isAbsolute(target)) {
      return { ok: false, reason: 'not_absolute' };
    }
    // 越界校验：若提供了 workspaceRoot，目标必须位于其内部。
    if (workspaceRoot && typeof workspaceRoot === 'string') {
      const root = path.resolve(workspaceRoot);
      const rel = path.relative(root, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, reason: 'out_of_workspace' };
      }
    }
    if (!existsSync(target)) {
      return { ok: false, reason: 'not_found' };
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(target).isDirectory();
    } catch {
      isDirectory = false;
    }
    // 目录直接在文件管理器中打开；文件优先用默认程序打开。
    if (isDirectory) {
      const err = await shell.openPath(target);
      if (err) {
        shell.showItemInFolder(target);
        return { ok: true, fallback: 'show-in-folder' };
      }
      return { ok: true };
    }
    const err = await shell.openPath(target);
    if (err) {
      // openPath 失败（无关联程序等）：回退到在文件管理器中定位高亮。
      shell.showItemInFolder(target);
      return { ok: true, fallback: 'show-in-folder' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'error', message: err?.message || String(err) };
  }
});

// 计算指定文件的 git diff，供渲染层在 Workbench 的 Diff 视图中展示。
// 入参 absPath 必须是绝对路径；workspaceRoot 为 git 仓库根（不传则用 absPath 所在目录）。
// 策略：优先 working tree diff；为空时回退 staged diff；仍为空且文件被跟踪时回退 HEAD 对比；
// 未跟踪文件用 git diff --no-index 与 /dev/null 对比。返回 { ok, diffText, status, error? }。
ipcMain.handle('git:diff', async (_event, { absPath, workspaceRoot, relPath } = {}) => {
  try {
    if (!absPath || typeof absPath !== 'string') {
      return { ok: false, status: 'invalid_path', diffText: '', error: 'invalid_path' };
    }
    let target = path.normalize(absPath);
    if (!path.isAbsolute(target)) {
      return { ok: false, status: 'invalid_path', diffText: '', error: 'not_absolute' };
    }
    // 跨仓库回退：absPath 在当前 workspace 找不到，但调用方提供了原始相对路径时，
    // 遍历所有已知 workspace 拼 relPath 查找，命中则改用该路径并标注实际命中的仓库。
    let resolvedFrom;
    if (!existsSync(target)) {
      let recovered = false;
      const cleanRel = typeof relPath === 'string' && relPath.trim()
        ? relPath.replace(/^[/\\]+/, '').replace(/^(\.\.?[/\\])+/, '')
        : '';
      if (cleanRel) {
        const all = settingsStore.getAll();
        const candidates = [
          ...(all.workspaces || []).map((w) => (w && typeof w === 'object' ? w.path : w)),
          all.activeWorkspace,
        ].filter((p) => typeof p === 'string' && p);
        const seen = new Set();
        for (const ws of candidates) {
          if (seen.has(ws)) continue;
          seen.add(ws);
          const candidate = path.normalize(path.join(ws, cleanRel));
          if (existsSync(candidate)) {
            target = candidate;
            resolvedFrom = ws;
            recovered = true;
            break;
          }
        }
      }
      if (!recovered) {
        return { ok: false, status: 'not_found', diffText: '', error: 'file_not_found' };
      }
    }
    const cwd = resolvedFrom
      ? resolvedFrom
      : (workspaceRoot && typeof workspaceRoot === 'string' && existsSync(workspaceRoot)
        ? workspaceRoot
        : path.dirname(target));

    // 解析仓库根，确认是 git 仓库。
    let repoRoot;
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        maxBuffer: 1024 * 1024 * 16,
      });
      repoRoot = stdout.trim();
    } catch {
      return { ok: false, status: 'not_git_repo', diffText: '', error: 'not_a_git_repository' };
    }

    // 注意：此处的 repoRelPath 是相对「仓库根」的路径，与入参 relPath（相对调用方 workspace）不同名以避免遮蔽。
    const repoRelPath = path.relative(repoRoot, target);

    // 判断文件是否被 git 跟踪。
    let tracked = true;
    try {
      await execFileAsync('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', '--', repoRelPath], {
        maxBuffer: 1024 * 1024 * 16,
      });
    } catch {
      tracked = false;
    }

    const runGit = async (args) => {
      try {
        const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], {
          maxBuffer: 1024 * 1024 * 32,
        });
        return stdout;
      } catch (err) {
        // git diff --no-index 在有差异时以退出码 1 返回，stdout 仍含 diff。
        if (err && typeof err.stdout === 'string' && err.stdout.length > 0) return err.stdout;
        throw err;
      }
    };

    if (!tracked) {
      // 未跟踪文件：与空文件对比，展示为全新增内容。
      const diffText = await runGit(['diff', '--no-index', '--', '/dev/null', target]);
      return { ok: true, status: diffText.trim() ? 'untracked' : 'no_changes', diffText, resolvedFrom };
    }

    // 1) working tree 改动
    let diffText = await runGit(['diff', '--', repoRelPath]);
    if (diffText.trim()) {
      return { ok: true, status: 'modified', diffText, resolvedFrom };
    }
    // 2) 已暂存改动
    diffText = await runGit(['diff', '--staged', '--', repoRelPath]);
    if (diffText.trim()) {
      return { ok: true, status: 'staged', diffText, resolvedFrom };
    }
    // 3) 无未提交改动：回退展示与上一次提交（HEAD~1）的对比，便于查看最近一次改动。
    try {
      diffText = await runGit(['diff', 'HEAD~1', 'HEAD', '--', repoRelPath]);
      if (diffText.trim()) {
        return { ok: true, status: 'last_commit', diffText, resolvedFrom };
      }
    } catch {
      // 仓库可能只有一次提交或无 HEAD~1，忽略。
    }
    return { ok: true, status: 'no_changes', diffText: '', resolvedFrom };
  } catch (err) {
    return { ok: false, status: 'error', diffText: '', error: err?.message || String(err) };
  }
});

// 校验给定路径是否对应磁盘上真实存在的文件。供渲染层判断聊天中的「路径样式文本」
// 是否为真实文件引用：git 分支名/仓库名/版本号（dev/0.0.1、origin/main、org/repo）
// 因磁盘上不存在而返回 exists:false，从而不被升级为可点链接——无需去识别「它是不是 git」。
// absPath 在当前 workspace 找不到时，复用 git:diff 的跨 workspace 回退：用 relPath 逐一拼接已知 workspace。
ipcMain.handle('fs:exists', (_event, { absPath, workspaceRoot, relPath } = {}) => {
  try {
    if (!absPath || typeof absPath !== 'string') return { exists: false };
    const target = path.normalize(absPath);
    if (!path.isAbsolute(target)) return { exists: false };
    if (existsSync(target)) {
      return { exists: true, isDir: statSync(target).isDirectory() };
    }
    const cleanRel = typeof relPath === 'string' && relPath.trim()
      ? relPath.replace(/^[/\\]+/, '').replace(/^(\.\.?[/\\])+/, '')
      : '';
    if (cleanRel) {
      const all = settingsStore.getAll();
      const candidates = [
        ...(all.workspaces || []).map((w) => (w && typeof w === 'object' ? w.path : w)),
        all.activeWorkspace,
        workspaceRoot,
      ].filter((p) => typeof p === 'string' && p);
      const seen = new Set();
      for (const ws of candidates) {
        if (seen.has(ws)) continue;
        seen.add(ws);
        const candidate = path.normalize(path.join(ws, cleanRel));
        if (existsSync(candidate)) {
          return { exists: true, isDir: statSync(candidate).isDirectory(), resolvedFrom: ws };
        }
      }
    }
    return { exists: false };
  } catch {
    return { exists: false };
  }
});

// 列出指定目录的单层子条目，供 Workbench「文件」视图的文件树懒加载/逐层展开。
// 入参 absPath 必须是绝对目录路径；absPath 在当前 workspace 找不到时复用 fs:exists/file:read
// 的跨 workspace 回退逻辑（用 relPath 逐一拼接已知 workspace）。
// 返回 { ok, status, entries:[{ name, isDir, absPath }], resolvedFrom?, error? }。
// entries 按「目录在前、同类按名称不区分大小写」排序；隐藏点文件（. 开头）一并返回，由渲染层决定是否显示。
ipcMain.handle('fs:read-dir', (_event, { absPath, workspaceRoot, relPath } = {}) => {
  try {
    if (!absPath || typeof absPath !== 'string') {
      return { ok: false, status: 'invalid_path', entries: [], error: 'invalid_path' };
    }
    let target = path.normalize(absPath);
    if (!path.isAbsolute(target)) {
      return { ok: false, status: 'invalid_path', entries: [], error: 'not_absolute' };
    }
    // 跨 workspace 回退：absPath 不存在但提供了 relPath 时，逐一拼接已知 workspace 查找。
    let resolvedFrom;
    if (!existsSync(target)) {
      let recovered = false;
      const cleanRel = typeof relPath === 'string' && relPath.trim()
        ? relPath.replace(/^[/\\]+/, '').replace(/^(\.\.?[/\\])+/, '')
        : '';
      if (cleanRel) {
        const all = settingsStore.getAll();
        const candidates = [
          ...(all.workspaces || []).map((w) => (w && typeof w === 'object' ? w.path : w)),
          all.activeWorkspace,
          workspaceRoot,
        ].filter((p) => typeof p === 'string' && p);
        const seen = new Set();
        for (const ws of candidates) {
          if (seen.has(ws)) continue;
          seen.add(ws);
          const candidate = path.normalize(path.join(ws, cleanRel));
          if (existsSync(candidate)) {
            target = candidate;
            resolvedFrom = ws;
            recovered = true;
            break;
          }
        }
      }
      if (!recovered) {
        return { ok: false, status: 'not_found', entries: [], error: 'dir_not_found' };
      }
    }
    let stat;
    try {
      stat = statSync(target);
    } catch {
      return { ok: false, status: 'not_found', entries: [], error: 'stat_failed' };
    }
    if (!stat.isDirectory()) {
      return { ok: false, status: 'not_dir', entries: [], resolvedFrom, error: 'not_a_directory' };
    }
    const dirents = readdirSync(target, { withFileTypes: true });
    const entries = dirents
      .map((d) => ({
        name: d.name,
        isDir: d.isDirectory(),
        absPath: path.join(target, d.name),
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' });
      });
    return { ok: true, status: 'ok', entries, resolvedFrom };
  } catch {
    return { ok: false, status: 'error', entries: [], error: 'read_dir_failed' };
  }
});

// 读取指定文件的完整文本内容，供 Workbench 的 Diff 视图「文件内容」分段查看。
// 入参 absPath 必须是绝对路径；absPath 在当前 workspace 找不到时复用 git:diff/fs:exists 的
// 跨 workspace 回退逻辑（用 relPath 逐一拼接已知 workspace）。
// 兜底：> 2MB 返回 too_large；检测到 NUL 字节判定二进制返回 binary；不存在返回 not_found。
// 返回 { ok, status, content, size?, resolvedFrom?, error? }。
ipcMain.handle('file:read', async (_event, { absPath, workspaceRoot, relPath } = {}) => {
  const MAX_BYTES = 2 * 1024 * 1024; // 2MB 上限
  try {
    if (!absPath || typeof absPath !== 'string') {
      return { ok: false, status: 'invalid_path', content: '', error: 'invalid_path' };
    }
    let target = path.normalize(absPath);
    if (!path.isAbsolute(target)) {
      return { ok: false, status: 'invalid_path', content: '', error: 'not_absolute' };
    }
    // 跨 workspace 回退：absPath 不存在但提供了 relPath 时，逐一拼接已知 workspace 查找。
    let resolvedFrom;
    if (!existsSync(target)) {
      let recovered = false;
      const cleanRel = typeof relPath === 'string' && relPath.trim()
        ? relPath.replace(/^[/\\]+/, '').replace(/^(\.\.?[/\\])+/, '')
        : '';
      if (cleanRel) {
        const all = settingsStore.getAll();
        const candidates = [
          ...(all.workspaces || []).map((w) => (w && typeof w === 'object' ? w.path : w)),
          all.activeWorkspace,
          workspaceRoot,
        ].filter((p) => typeof p === 'string' && p);
        const seen = new Set();
        for (const ws of candidates) {
          if (seen.has(ws)) continue;
          seen.add(ws);
          const candidate = path.normalize(path.join(ws, cleanRel));
          if (existsSync(candidate)) {
            target = candidate;
            resolvedFrom = ws;
            recovered = true;
            break;
          }
        }
      }
      if (!recovered) {
        return { ok: false, status: 'not_found', content: '', error: 'file_not_found' };
      }
    }
    // 必须是文件（拒绝目录）。
    let stat;
    try {
      stat = statSync(target);
    } catch {
      return { ok: false, status: 'not_found', content: '', error: 'stat_failed' };
    }
    if (!stat.isFile()) {
      return { ok: false, status: 'not_file', content: '', error: 'not_a_file', resolvedFrom };
    }
    if (stat.size > MAX_BYTES) {
      return { ok: false, status: 'too_large', content: '', size: stat.size, resolvedFrom, error: 'file_too_large' };
    }
    const buf = readFileSync(target);
    // 二进制检测：扫描前 8KB 是否含 NUL 字节。
    const sniffLen = Math.min(buf.length, 8192);
    for (let i = 0; i < sniffLen; i += 1) {
      if (buf[i] === 0) {
        return { ok: false, status: 'binary', content: '', size: stat.size, resolvedFrom, error: 'binary_file' };
      }
    }
    return { ok: true, status: 'ok', content: buf.toString('utf8'), size: stat.size, resolvedFrom };
  } catch (err) {
    return { ok: false, status: 'error', content: '', error: err?.message || 'read_failed' };
  }
});

// ── 会话级内嵌浏览器标签控制句柄注册（见 ADR 40 / 46）──
// renderer 上报 webContentsId + conversationId + browserTabId；main 按会话登记活跃标签，
// Agent 的 browser_* provider 只解析工具调用所属会话的目标。webview 卸载时注销。
ipcMain.handle('browser:register-webcontents', (_event, registration = {}) => {
  const hadActiveBrowser = getActiveWebContentsId() != null;
  const result = registerBrowserWebContents(registration);
  if (hadActiveBrowser !== (getActiveWebContentsId() != null)) rebuildAppMenu();
  return result;
});
ipcMain.handle('browser:unregister-webcontents', (_event, registration = {}) => {
  const hadActiveBrowser = getActiveWebContentsId() != null;
  const result = unregisterBrowserWebContents(registration);
  if (hadActiveBrowser !== (getActiveWebContentsId() != null)) rebuildAppMenu();
  return result;
});

// ── Conversations ──
ipcMain.handle('conversations:list', (_, params = {}) => {
  const wantsPage = params?.paginated === true || params?.limit != null || params?.cursor != null;
  const listParams = {
    status: params?.status,
    includeMessageCount: params?.includeMessageCount,
    backfillMessageCount: params?.backfillMessageCount,
    limit: params?.limit,
    cursor: params?.cursor,
    paginated: wantsPage,
  };
  if (params?.workspacePath !== undefined) {
    return conversationStore.listConversationsByWorkspace(params.workspacePath, listParams);
  }
  return conversationStore.listConversations(listParams);
});
ipcMain.handle('conversations:search', (_, params) => conversationStore.searchConversations(params || {}));
ipcMain.handle('conversations:create', (_, params) => conversationStore.createConversation(params));
ipcMain.handle('conversations:get', (_, { id }) => conversationStore.getConversation(id));
ipcMain.handle('conversations:update-title', (_, { id, title }) => conversationStore.updateTitle(id, title));
ipcMain.handle('conversations:update-mode', (_, { id, mode }) => conversationStore.updateMode(id, mode));
ipcMain.handle('conversations:update-model-effort', (_, { id, effort, modelProviderId }) => conversationStore.updateModelEffort(id, { effort, modelProviderId }));
ipcMain.handle('conversations:append-message', (_, { id, message }) => conversationStore.appendMessage(id, message));
ipcMain.handle('conversations:update-last-message', (_, { id, content }) => conversationStore.updateLastMessage(id, content));
ipcMain.handle('conversations:replace-messages', (_, { id, messages, allowEmpty = false }) => conversationStore.replaceMessages(id, messages, { allowEmpty }));
ipcMain.handle('conversations:archive', (_, { id }) => conversationStore.archiveConversation(id));
ipcMain.handle('conversations:restore', (_, { id }) => conversationStore.restoreConversation(id));
ipcMain.handle('conversations:pin', (_, { id }) => conversationStore.pinConversation(id));
ipcMain.handle('conversations:unpin', (_, { id }) => conversationStore.unpinConversation(id));
ipcMain.handle('conversations:reorder-pinned', (_, { ids }) => conversationStore.reorderPinnedConversations(ids));
ipcMain.handle('conversations:auto-archive', (_, { before, excludeIds } = {}) => {
  const activeStreamIds = llmChatService.listActiveConversationIds();
  return conversationStore.autoArchiveConversations({ before, excludeIds: [...new Set([...(excludeIds || []), ...activeStreamIds])] });
});
ipcMain.handle('conversations:delete', (_, { id }) => {
  // IPC 层编排：删除会话后级联硬删除该会话名下的全部 Goal 计划（见 ADR 34）。
  // 两个 store 保持独立（互不 import），仅在此组合层互相知晓。
  const result = conversationStore.deleteConversation(id);
  try {
    goalPlanStore.deletePlanByConversation(id);
  } catch (err) {
    // 级联清理失败不回滚会话删除，但显式告警以便排查（不要静默吞）。
    console.warn('[main] cascade deletePlanByConversation failed:', err);
  }
  try {
    // 工具结果材料化 artifact 随会话级联清理(17 号文档阶段 E / ADR 34 同口径)。
    removeConversationToolArtifacts({ conversationId: id });
  } catch (err) {
    console.warn('[main] cascade removeConversationToolArtifacts failed:', err);
  }
  return result;
});
// 累计计费账本:独立于消息/压缩,累加到 index meta 的 lifetimeUsage(见 ADR 23)。
// 压缩(replace-messages)只重写消息文件,不碰 meta,故 lifetimeUsage 不受压缩影响。
ipcMain.handle('conversations:add-usage', (_, { id, usage }) => conversationStore.addUsage(id, usage));

// ── Goal Plans（Plan 审批计划 / Goal 自驱目标追踪，均持久化为 Evidence/artifact）──
// 见 Plan / Goal 模式设计。progress 由 store 自底向上聚合，调用方不可手填。
ipcMain.handle('goalPlans:list', (_, params) => {
  if (params?.conversationId !== undefined) return goalPlanStore.listPlanDetailsByConversation(params.conversationId);
  return goalPlanStore.listPlanDetails();
});
// 侧栏徽标：只返回 awaiting_approval 计数聚合，避免全量 hydrate GoalPlan。
ipcMain.handle('goalPlans:awaiting-counts', () => goalPlanStore.countAwaitingApprovalsByConversation());
ipcMain.handle('goalPlans:get', (_, { planId }) => goalPlanStore.getPlan(planId));
ipcMain.handle('goalPlans:create', (_, { draft }) => goalPlanStore.createPlan(draft));
ipcMain.handle('goalPlans:revise', (_, { planId, patch, reason, changedBy }) =>
  goalPlanStore.revisePlan(planId, patch, { reason, changedBy }));
ipcMain.handle('goalPlans:approve', (_, { planId, approval }) => {
  const plan = goalPlanStore.recordApproval(planId, approval);
  // plan/goal 执行段合一(修订 ADR 41,见 B2-b):批准即自动启动 Runner 托管推进,
  // 兑现「批准并执行」按钮的字面语义。plan 与 goal 的差异收敛到「批准前的规划把关粒度」;
  // 批准后二者共用同一自驱 Runner,且因 runGoalTurn 写死 mode:'goal',续推上下文注入、
  // 防偏航 re-anchor、Verification Gate 三大护栏对 plan 同样生效。
  if (approval?.decision === 'approve') {
    void goalRunner?.start(planId);
  }
  return plan;
});
ipcMain.handle('goalPlans:set-status', (_, { planId, status }) => goalPlanStore.setPlanStatus(planId, status));
ipcMain.handle('goalPlans:record-manual-confirmation', (_, { planId, confirmation }) =>
  goalPlanStore.recordManualConfirmation(planId, confirmation));
ipcMain.handle('goalRunner:get-state', (_, { planId }) => goalRunner?.getState(planId) ?? null);
ipcMain.handle('goalRunner:start', (_, { planId, options } = {}) => goalRunner?.start(planId, options) ?? null);
ipcMain.handle('goalRunner:pause', (_, { planId }) => goalRunner?.pause(planId) ?? null);
ipcMain.handle('goalRunner:resume', (_, { planId, options } = {}) => goalRunner?.resume(planId, options) ?? null);
ipcMain.handle('goalRunner:clear', (_, { planId }) => goalRunner?.clear(planId) ?? null);
ipcMain.handle('goalPlans:record-task-evidence', (_, { planId, taskId, change }) =>
  goalPlanStore.recordTaskEvidence(planId, taskId, change));
ipcMain.handle('goalPlans:delete', (_, { planId }) => {
  goalPlanStore.deletePlan(planId);
  return goalPlanStore.listPlanDetails();
});

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
    if (typeof goalPlanStore.getActivePlanByConversation !== 'function') return;
    const active = goalPlanStore.getActivePlanByConversation(conversationId);
    // 三分支决策抽到纯函数 decideIntakeConvergence（可单测）；main 只负责执行副作用。
    if (decideIntakeConvergence(active, outcome) === 'remove') {
      goalPlanStore.deletePlan(active.planId);
    }
  } catch (error) {
    console.warn('[main] intake convergence failed:', error?.message || error);
  }
}

ipcMain.handle('chat:send', (event, {
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
}) => {
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
  if (mode === 'goal' && conversationId && typeof goalPlanStore.upsertGoalContract === 'function') {
    const goal = latestUserTextFromProviderMessages(messages);
    if (goal) {
      try {
        const activePlan = goalPlanStore.getActivePlanByConversation(conversationId);
        const activeGoal = activePlan && goalPlanIsSelfDriven(activePlan) ? activePlan : null;
        const route = routeGoalMessage({ messageText: goal, activeGoalPlan: activeGoal });
        if (route.type === 'append_goal_event') {
          applyGoalMessageRoute({
            route,
            activeGoalPlan: activeGoal,
            goalPlanStore,
          });
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
    webContents: event.sender,
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
  if (mode === 'goal' && conversationId) {
    return Promise.resolve(outcomePromise).then((outcome) => {
      convergeIntakeAfterGoalTurn(conversationId, outcome);
      const acceptedGoal = goalPlanStore.getActivePlanByConversation(conversationId);
      // intake 路径下 createIntakeContract 初始 status 为 executing；goal_create_plan
      // 原地升级后 activation.kind=accepted_goal，但 status 可能仍是 executing。
      // auto-start 判定抽到 shouldAutoStartAcceptedGoalRunner，accepted/executing 都要启动。
      if (shouldAutoStartAcceptedGoalRunner(acceptedGoal)) {
        // 双保险：outcome resolve 时再幂等 kick 一次。不能在这里按 conversation
        // force-complete；goal-accepted 回调可能已经启动 Runner，再按会话收口会误杀 Runner 流。
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
});
ipcMain.handle('chat:abort', (_, { streamId }) =>
  llmChatService.abort(streamId));

// ── Stream reattach (ADR 22) ──
// renderer 经 HMR 重载或重新打开后,内存里的流式状态丢失,但 main 进程的
// 流式推理仍在继续。renderer 挂载时调用此入口,询问"当前有无活跃流",
// 若有则取回已累积的正文/思考文本,无缝接回 UI(不重发、不打断后端)。
ipcMain.handle('chat:stream:reattach', (_event, { streamId, conversationId } = {}) =>
  llmChatService.reattach({ streamId, conversationId }));

// 全局活跃流查询:renderer 挂载时拉取当前正在运行的会话列表,补齐"未点进去"的会话状态。
// 之后的变更由 main 主动广播 chat:stream:active-changed 推送。
ipcMain.handle('chat:stream:list-active', () => ({
  // ADR 27: 保留 conversationIds(既有消费者),附带带工作区维度的 streams。
  conversationIds: llmChatService.listActiveConversationIds(),
  streams: llmChatService.listActiveStreams(),
}));

ipcMain.handle('chat:compact', async (event, { conversationId, streamId }) => {
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
  if (provider && credential?.apiKey) {
    const resolvedChannel = resolveChannel({
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

  const apiMessages = [
    { role: 'system', content: systemPrompt },
    ...toDesktopProviderMessages(canonicalHistory.messages),
  ];

  // 登记表/横幅/进度/持久化/完成事件全部收敛到 runCompactionCheck 单入口（manual 语义）：
  // 手动 /compact = force 全量压缩 + 强制横幅；不再在 handler 内复制平行实现。
  // 见 knowledge/architecture/23-compaction-path-root-governance.md（单闸门不变式）。
  try {
    const outcome = await runCompactionCheck({
      messages: apiMessages,
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
      webContents: event.sender,
      force: true,
      manual: true,
      // 手动 /compact 保持真·全量压缩语义：不保留最新用户原文。
      preserveLatestUserTurn: false,
      continuityContext: priorContinuityContext,
    });

    if (!outcome.compacted) return { compacted: false };

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
});

// ── 压缩态查询（按 conversationId）──
// 渲染层切会话时调用：返回该会话当前是否正在压缩及进度，用于恢复横幅。
// 压缩态真值落在主进程登记表，渲染层只负责表达，不再各自持有运行真值。
ipcMain.handle('chat:compaction:get', (_event, { conversationId } = {}) =>
  getCompaction(conversationId));

// ── restored 重投影(21 号文档 13.3 / 23 号治理文档 Phase 1.4)──
// 会话打开时若持久化快照缺失/失效/来自其他宿主(source ≠ desktop),renderer 调此处
// 按当前宿主的完整成分(全量 system context + 模式投影工具 schema + active 历史)重算投影,
// 而不是用缺成分的本地估算兜底(那正是历史上 RC1 失准的根源)。
// 重算成功后回写 contextSnapshot(source: desktop),下次打开直接命中。
ipcMain.handle('chat:context:restored', (_event, { conversationId } = {}) => {
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
  const provider = (conv.modelProviderId && providers.find((p) => p.id === conv.modelProviderId))
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
  const lifecycle = createContextProjectionLifecycle();
  const snapshot = lifecycle.restored({
    messages: projectedMessages,
    tools,
    contextWindow: provider?.contextWindow || null,
    reason: 'restored',
  });
  const projection = snapshot.projection;
  if (!Number.isFinite(projection.nextRequestInputTokens) || projection.nextRequestInputTokens <= 0) {
    return null;
  }
  try {
    conversationStore.updateContextSnapshot(conversationId, {
      nextRequestInputTokens: projection.nextRequestInputTokens,
      contextWindow: projection.contextWindow,
      projectorVersion: CANONICAL_HISTORY_PROJECTOR_VERSION,
      source: 'desktop',
    });
  } catch (error) {
    console.warn('[main] failed to persist restored projection:', error?.message || error);
  }
  return {
    phase: 'restored',
    nextRequestInputTokens: projection.nextRequestInputTokens,
    contextWindow: projection.contextWindow,
    percent: projection.percent,
    pressure: projection.pressure,
  };
});

ipcMain.handle('prompt-snapshots:list', (_event, params = {}) =>
  promptSnapshotStore.list({ limit: params?.limit }));
ipcMain.handle('prompt-snapshots:get', (_event, { id }) =>
  promptSnapshotStore.get(id));
ipcMain.handle('prompt-context-epochs:list', (_event, params = {}) =>
  promptSnapshotStore.listContextEpochs({ limit: params?.limit }));
ipcMain.handle('prompt-context-epochs:events', (_event, params = {}) =>
  promptSnapshotStore.listContextEpochEvents({
    limit: params?.limit,
    conversationId: params?.conversationId,
    contextEpochId: params?.contextEpochId,
  }));
ipcMain.handle('prompt-context-epochs:chain', (_event, params = {}) =>
  promptSnapshotStore.getContextEpochChain({
    conversationId: params?.conversationId ?? null,
    contextEpochId: params?.contextEpochId ?? null,
    limit: params?.limit,
  }));

// ── LLM Providers ──
ipcMain.handle('llm:channels:list', () => listChannelDescriptors());

// 设置页/模型列表加载前，对 access 过期的 OAuth 渠道静默 ensureFresh 并写回 token，
// 避免 refresh 仍可用时误报「登录已过期」。失败不抛，UI 继续用本地 oauthStatus。
let missingPricingBackfillPromise = null;

function scheduleMissingPricingBackfill(reason = 'startup') {
  if (typeof llmConfigStore.backfillMissingPricingFromModelsDev !== 'function') return;
  if (missingPricingBackfillPromise) return missingPricingBackfillPromise;
  missingPricingBackfillPromise = llmConfigStore.backfillMissingPricingFromModelsDev()
    .then((result) => {
      if (result?.updated) {
        console.info(`[llm] models.dev pricing backfill (${reason}): updated ${result.updated}/${result.examined}`);
      }
      return result;
    })
    .catch((err) => {
      console.warn('[llm] models.dev pricing backfill failed:', err?.message || err);
      return null;
    })
    .finally(() => {
      missingPricingBackfillPromise = null;
    });
  return missingPricingBackfillPromise;
}

async function listProvidersWithSilentOAuthRefresh() {
  try {
    await refreshExpiredOAuthProviders({ llmConfigStore });
  } catch (err) {
    console.warn('[llm] silent oauth refresh failed:', err?.message || err);
  }
  // Fire-and-forget: fill missing prices for saved models when settings/model list loads.
  void scheduleMissingPricingBackfill('llm:list');
  return llmConfigStore.listProviders();
}

async function listGroupsWithSilentOAuthRefresh() {
  try {
    await refreshExpiredOAuthProviders({ llmConfigStore });
  } catch (err) {
    console.warn('[llm] silent oauth refresh failed:', err?.message || err);
  }
  return llmConfigStore.listGroups();
}

// 跨会话用量汇总（精简使用统计页）：会话 lifetimeUsage + 当前 provider 单价估算。
ipcMain.handle('usage:stats', () => collectUsageStats({ conversationStore, llmConfigStore }));
// 请求日志按天聚合（Token 热力图 / 趋势）：range = 7d|1m|3m|6m|1y。
ipcMain.handle('usage:daily', (_event, params) => collectUsageDaily({ range: params?.range }));

// 设置页读取独立渠道视图，包含尚未配置任何模型的空渠道。
ipcMain.handle('llm:groups:list', () => listGroupsWithSilentOAuthRefresh());
ipcMain.handle('llm:list', () => listProvidersWithSilentOAuthRefresh());
// 兼容旧 preload API；聊天与设置统一返回已配置模型真值，不再投影目录候选。
ipcMain.handle('llm:chat:list', () => listProvidersWithSilentOAuthRefresh());
ipcMain.handle('llm:add', (_, config) => {
  const provider = llmConfigStore.addProvider(config);
  if (provider.isDefault) recordProviderBaseline('initial', provider);
  return provider;
});
ipcMain.handle('llm:update', (_, { id, ...patch }) => {
  const before = llmConfigStore.listProviders().find((provider) => provider.id === id) ?? null;
  const updated = llmConfigStore.updateProvider(id, patch);
  if (providerPromptTargetChanged(before, updated)) {
    recordProviderBaseline('model_switch', updated);
  }
  return updated;
});
ipcMain.handle('llm:duplicate', (_, { id }) => {
  llmConfigStore.duplicateProvider(id);
  return llmConfigStore.listProviders();
});
// B-2 在已有 provider 组内新增一个模型:凭证继承自组内首条,无需重填 apiKey。
ipcMain.handle('llm:add-model', (_, { groupId, ...patch }) => {
  llmConfigStore.addModel(groupId, patch);
  return llmConfigStore.listProviders();
});
ipcMain.handle('llm:remove', (_, { id }) => {
  const beforeDefault = llmConfigStore.listProviders().find((provider) => provider.isDefault) ?? null;
  const providers = llmConfigStore.removeProvider(id);
  const afterDefault = providers.find((provider) => provider.isDefault) ?? null;
  if (beforeDefault?.id === id && afterDefault) {
    recordProviderBaseline('model_switch', afterDefault);
  }
  return providers;
});
// B-2 删除整个 provider 组(同 groupId 的全部模型)。若删掉的组含当前默认模型,
// removeGroup 会把默认转移到剩余首条,这里据此记录 baseline。
ipcMain.handle('llm:remove-group', (_, { groupId }) => {
  const beforeDefault = llmConfigStore.listProviders().find((provider) => provider.isDefault) ?? null;
  const providers = llmConfigStore.removeGroup(groupId);
  const afterDefault = providers.find((provider) => provider.isDefault) ?? null;
  if (beforeDefault && (beforeDefault.groupId ?? beforeDefault.id) === groupId && afterDefault) {
    recordProviderBaseline('model_switch', afterDefault);
  }
  return providers;
});
ipcMain.handle('llm:set-default', (_, { id }) => {
  const beforeDefault = llmConfigStore.listProviders().find((provider) => provider.isDefault) ?? null;
  const providers = llmConfigStore.setDefault(id);
  const afterDefault = providers.find((provider) => provider.id === id) ?? null;
  if (afterDefault && beforeDefault?.id !== afterDefault.id) {
    recordProviderBaseline('model_switch', afterDefault);
  }
  return providers;
});
ipcMain.handle('llm:test', (_, { id }) => llmConfigStore.testConnection(id));
ipcMain.handle('llm:quota', async (_, { id, force } = {}) => fetchProviderSubscriptionQuota({
  providerId: id,
  llmConfigStore,
  force: Boolean(force),
  // 与 OAuth / 模型调用一致：走 Node↔Electron 双通道 + 代理回退。
  // 裸 fetch 在系统代理/跨境网络下会直接 TypeError: fetch failed。
  fetchImpl: (url, init) => fetchWithConnectionRecovery(url, init, {
    provider: 'subscription-quota',
    model: 'quota',
    maxRetries: 1,
  }),
}));

// ── Provider OAuth(ADR 28+) ──
// 同一时刻只允许一个进行中的 browser 登录会话,便于取消。
let activeOAuthLogin = null;
let activeOAuthVerificationUrl = null;

ipcMain.handle('llm:oauth:start', async (event, params) => {
  // ADR 28: 订阅登录链路必须"先登录、成功后才落盘"。
  // - { id }   : 对已存在的订阅 provider 重新登录(刷新 token)。
  // - { draft }: 新建订阅。draft 是表单草稿,登录成功后才创建 provider;
  //              登录失败/取消则什么都不写入,绝不留下没有 token 的死配置。
  const id = params?.id ?? null;
  const draft = params?.draft ?? null;
  if (!id && !draft) throw new Error('provider id or draft required');
  const existing = id ? llmConfigStore.listProviders().find((provider) => provider.id === id) : null;
  const authMethod = draft?.authMethod || existing?.authMethod || 'oauth_chatgpt';
  if (authMethod !== 'oauth_chatgpt' && authMethod !== 'oauth_google' && authMethod !== 'oauth_grok') {
    throw new Error(`unsupported_oauth_method:${authMethod}`);
  }
  if (activeOAuthLogin) {
    try { activeOAuthLogin.cancel(); } catch {}
    activeOAuthLogin = null;
    // cancel() 触发的本地回调 server.close() 是异步释放端口的,
    // 稍等一拍再起新登录,避免立刻 listen 撞上尚未释放的回调端口
    // (EADDRINUSE)。oauth 模块内部还有一次重试兜底。
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const session = authMethod === 'oauth_google'
    ? startGoogleBrowserLogin()
    : authMethod === 'oauth_grok'
      ? startGrokOAuthLogin({
        fetchImpl: (url, init) => fetchWithConnectionRecovery(url, init, {
          provider: 'grok',
          model: 'oauth',
          maxRetries: 1,
        }),
        openExternal: async (url) => {
          activeOAuthVerificationUrl = url;
          await shell.openExternal(url);
        },
        onPending: (pending) => {
          activeOAuthVerificationUrl = pending.verificationUrl;
          clipboard.writeText(pending.userCode);
          const target = getOAuthWindowWebContents(event.sender, BrowserWindow.getAllWindows());
          target?.send('llm:oauth:pending', pending);
        },
        onTokenReady: () => {
          const target = getOAuthWindowWebContents(event.sender, BrowserWindow.getAllWindows());
          target?.send('llm:oauth:authorized');
        },
      })
      : startBrowserLogin();
  activeOAuthLogin = session;
  let createdId = null;
  try {
    // 先完成浏览器授权,拿到 token 之后再决定是否落盘。
    const tokens = await session.promise;
    // 新建订阅:授权成功后才原子创建 provider。
    const targetId = id
      ?? (createdId = llmConfigStore.addProvider({ ...draft, authMethod }).id);
    llmConfigStore.setOAuthTokens(targetId, tokens);
    let provider = llmConfigStore.listProviders().find((p) => p.id === targetId) ?? null;
    let models = null;
    if (authMethod === 'oauth_grok') {
      const catalog = await listGrokBuildModels(tokens.access, { baseUrl: provider?.baseUrl });
      models = catalog.models;
      const preferred = models.find((model) => model.id === 'grok-4.5') ?? models[0] ?? null;
      if (preferred && provider?.model !== preferred.id) {
        provider = llmConfigStore.updateProvider(targetId, {
          model: preferred.id,
          contextWindow: preferred.contextWindow,
          supportsVision: preferred.supportsVision,
          supportsReasoning: preferred.supportsReasoning,
        });
      }
    } else if (authMethod === 'oauth_google') {
      // 对齐 gemini-cli：登录成功后挂 curated 模型目录，默认 DEFAULT_GEMINI_MODEL。
      // 不调用 GET /v1beta/models；目录来自 gemini-cli 本地常量。
      const catalog = await listGeminiModels(tokens);
      models = catalog.models;
      const preferred = preferGeminiModel(models);
      let oauthProjectId = null;
      try {
        oauthProjectId = await resolveGeminiCodeAssistProjectId({
          accessToken: tokens.access,
          fetchImpl: (url, init) => fetchWithConnectionRecovery(url, init),
        });
      } catch (error) {
        console.warn('[oauth] resolve Gemini Code Assist project failed:', error?.message || error);
      }
      if (preferred?.id || oauthProjectId) {
        provider = llmConfigStore.updateProvider(targetId, {
          ...(preferred?.id ? {
            model: preferred.id,
            modelLabel: preferred.label || preferred.id,
            contextWindow: preferred.contextWindow,
            maxOutputTokens: preferred.maxOutputTokens,
            metadataSource: catalog.source || 'builtin',
            metadataSyncedAt: new Date().toISOString(),
          } : {}),
          ...(oauthProjectId ? { oauthProjectId } : {}),
        }) || provider;
      }
    }
    if (provider) recordProviderBaseline('oauth_login', provider);
    return { success: true, provider, models };
  } catch (err) {
    // 若已创建了草稿 provider 但 token 写入失败,回滚以保持"失败不留痕"。
    if (createdId) {
      try { llmConfigStore.removeProvider(createdId); } catch {}
    }
    return { success: false, error: err?.message || 'oauth_login_failed' };
  } finally {
    if (activeOAuthLogin === session) {
      activeOAuthLogin = null;
      activeOAuthVerificationUrl = null;
    }
  }
});

ipcMain.handle('llm:oauth:open-pending', async () => {
  if (!activeOAuthLogin || !activeOAuthVerificationUrl) {
    return { success: false, error: 'oauth_pending_url_unavailable' };
  }
  try {
    await shell.openExternal(activeOAuthVerificationUrl);
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message || 'oauth_open_browser_failed' };
  }
});

ipcMain.handle('llm:oauth:cancel', () => {
  if (activeOAuthLogin) {
    try { activeOAuthLogin.cancel(); } catch {}
    activeOAuthLogin = null;
  }
  activeOAuthVerificationUrl = null;
  return { success: true };
});

// 登录后远程拉取可用模型(失败回退内置清单)。临近过期则刷新并回写 token。
ipcMain.handle('llm:models:list', async (_event, { id }) => {
  if (!id) throw new Error('provider id required');
  const credential = llmConfigStore.getCredential(id);
  const provider = llmConfigStore.listProviders().find((p) => p.id === id) ?? null;
  const authMethod = credential?.authMethod || provider?.authMethod || 'oauth_chatgpt';
  // channelId=qoder 也视为 Qoder 私有接口，避免历史配置 authMethod 写错时误走 OpenAI /models。
  if (
    authMethod === 'qoder_local_auth'
    || authMethod === 'local_cli'
    || provider?.channelId === 'qoder'
  ) {
    const { models, source, error } = await listQoderModels();
    return { success: true, models, source, error };
  }
  // 自带 API key 的 provider:从 /v1/models(及 Anthropic/Gemini 兼容端点)远程拉取。
  // 复用 store 解析好的 wire/baseUrl/headers/apiKey。拉取失败时返回明确错误与空列表:
  // 不套用订阅(gpt-5 家族)目录做兜底——那对 DeepSeek/Qwen 等第三方后端毫无意义且会误导,
  // 用户可据错误改配置或手动填模型。
  if (authMethod === 'api_key') {
    const reqConfig = llmConfigStore.getApiKeyRequestConfig(id);
    if (!reqConfig) {
      return { success: false, models: [], error: 'api_key_not_configured' };
    }
    try {
      const { models, source } = await listOpenAICompatibleModels(reqConfig);
      return { success: true, models, source };
    } catch (err) {
      return { success: false, models: [], error: err?.message || 'models_list_failed' };
    }
  }
  const tokens = credential?.tokens || null;
  if (!tokens?.access) {
    return { success: false, models: [], error: 'oauth_not_logged_in' };
  }
  try {
    const { tokens: fresh, refreshed } = authMethod === 'oauth_google'
      ? await ensureFreshGoogleTokens(tokens)
      : authMethod === 'oauth_grok'
        ? await ensureFreshGrokTokens(tokens)
        : await ensureFreshTokens(tokens);
    if (refreshed) llmConfigStore.setOAuthTokens(id, fresh);
    const { models, source, error } = authMethod === 'oauth_google'
      ? await listGeminiModels(fresh)
      : authMethod === 'oauth_grok'
        ? await listGrokBuildModels(fresh.access, { baseUrl: provider?.baseUrl })
        : await listSubscriptionModels(fresh);
    return { success: true, models, source, error };
  } catch (err) {
    return { success: false, models: [], error: err?.message || 'models_list_failed' };
  }
});

// 用表单里填的临时配置(baseUrl/apiKey/channelId 等)直接拉模型,不落盘、不需要 provider id。
// 供"添加渠道"弹窗在保存前预览可用模型、勾选多个模型一次性创建。
ipcMain.handle('llm:models:fetch', async (_event, config) => {
  if (!config) return { success: false, models: [], error: 'config_required' };
  try {
    const authMethod = config.authMethod || 'api_key';
    // Qoder 私有接口复用本机 CLI 登录态；目录优先走官方 SDK，失败再读 ~/.qoder 缓存。
    if (authMethod === 'qoder_local_auth' || authMethod === 'local_cli' || config.channelId === 'qoder') {
      const { models, source, error } = await listQoderModels();
      return {
        success: true,
        models,
        source,
        ...(error ? { error } : {}),
      };
    }
    const resolved = resolveChannel({
      channelId: config.channelId,
      wireOverride: config.wireOverride,
      authMethod: 'api_key',
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      customHeaders: config.customHeaders,
    });
    const { models, source } = await listOpenAICompatibleModels({
      baseUrl: resolved.baseUrl,
      headers: resolved.headers,
      wire: resolved.wire,
      apiKey: config.apiKey,
    });
    return { success: true, models, source };
  } catch (err) {
    return { success: false, models: [], error: err?.message || 'models_fetch_failed' };
  }
});

// ── Host restart (self-iteration M3, see docs/architecture/21-...) ──
// 由实验体(lab)程序化重启本体(host)。施动者在本体进程树之外，故 lab 调用安全。
const hostRestarter = createHostRestarter({ workspaceRoot });
ipcMain.handle('host:restart', (_event, payload = {}) => {
  // hostDir 优先使用调用方显式传入；否则按"当前 lab 工作区去掉 -lab 后缀"推导本体目录。
  let hostDir = payload.hostDir;
  if (!hostDir && workspaceRoot) {
    hostDir = workspaceRoot.endsWith('-lab')
      ? workspaceRoot.slice(0, -'-lab'.length)
      : workspaceRoot;
  }
  // 原子续传:若调用方随重启带了 pendingTask,先落盘再重启。
  // 这样新实例启动后 consume 即可取回,避免"写了没重启/重启没写"竞态。
  if (payload.pendingTask) {
    try {
      writePendingTask(payload.pendingTask);
    } catch (err) {
      // 落盘失败不阻断重启;续传降级为本次不可用,记录供排查。
      console.error('[pending-task] failed to persist before restart:', err);
    }
  }
  return hostRestarter.restartHost({ hostDir, port: payload.port });
});

// ── Pending Task 续传(跨重启)──
// 重启会中断当前会话;为免用户手动说"继续",重启前由 renderer 调 write 把待办落盘,
// 新实例启动后 renderer 主动调 consume 取回(read-and-clear,一次性),
// 再由 renderer 用自身上下文发起 chat:send 续执行。
// 续传必须走 renderer 拉取,因为 chat:send 依赖 event.sender 推流回发起方;
// main 主动发起没有 renderer 上下文,故不能在 main 内直接调 chat:send。
// 会话锚定(ADR 21):workspace 由 main 持有并负责补齐 + 校验,
// renderer 只需提供 { sessionId, task }(它有 conversationId,但拿不到 workspace 绝对路径)。
function withWorkspace(task) {
  return { ...task, workspace: workspaceRoot ?? null };
}
// 读回时校验 workspace 匹配:防止把 A 工作区的续传任务恢复到 B 工作区。
// workspaceRoot 为 null(打包态)时不做跨工作区校验,直接放行。
function matchWorkspace(record) {
  if (!record) return null;
  if (workspaceRoot && record.workspace && record.workspace !== workspaceRoot) {
    console.warn('[pending-task] workspace mismatch, discarding:', record.workspace, '!=', workspaceRoot);
    clearPendingTask();
    return null;
  }
  return record;
}
ipcMain.handle('pending-task:write', (_event, task = {}) => {
  return writePendingTask(withWorkspace(task));
});
ipcMain.handle('pending-task:consume', () => {
  return matchWorkspace(readAndClearPendingTask());
});
// peek/clear 分离:解决 React StrictMode 双挂载 + 未就绪时序导致的"读后即清却没发出去"。
// renderer 启动时先 peek(文件保留)拿到任务并自动发送;发送成功后再显式 clear。
// 任一环节中断(重挂载/崩溃/未就绪),文件仍在,下次启动可重试,任务不被吞。
ipcMain.handle('pending-task:peek', () => {
  return matchWorkspace(peekPendingTask());
});
ipcMain.handle('pending-task:clear', () => {
  clearPendingTask();
  return true;
});

// ── MCP (local only) ──
ipcMain.handle('mcp:list-installed', () => mcpRegistry.listInstalled());
ipcMain.handle('mcp:list-capabilities', () => mcpRegistry.listCapabilityManifests());
ipcMain.handle('mcp:list-credentials', () => mcpCredentialStore.listCredentials());
ipcMain.handle('mcp:put-credential', (_, item) => mcpCredentialStore.putCredential(item));
ipcMain.handle('mcp:delete-credential', (_, params) => mcpCredentialStore.deleteCredential(params?.credentialRef ?? params));
ipcMain.handle('mcp:install', (_, item) => mcpRegistry.install(item));
ipcMain.handle('mcp:upsert-server', (_, item) => mcpRegistry.upsertServer(item));
ipcMain.handle('mcp:uninstall', (_, params) => {
  const serverId = params?.mcpId ?? params?.serverId;
  // 卸载前取出该 server 绑定的 credentialRef，卸载后连带删除，
  // 避免凭证变成孤儿留在库里（重新添加同名 server 时会再堆一条重复凭证）。
  let boundCredentialRef = null;
  try {
    boundCredentialRef = mcpRegistry.getServer(serverId)?.auth?.credentialRef ?? null;
  } catch {
    boundCredentialRef = null;
  }
  const result = mcpRegistry.uninstall(serverId);
  if (boundCredentialRef) {
    try {
      mcpCredentialStore.deleteCredential(boundCredentialRef);
    } catch (err) {
      console.error('[mcp] delete bound credential on uninstall failed:', err);
    }
  }
  return result;
});
ipcMain.handle('mcp:set-enabled', (_, params) => mcpRegistry.setEnabled(params?.serverId ?? params?.mcpId, params?.enabled));
ipcMain.handle('mcp:set-tool-visibility', (_, params) => mcpRegistry.setToolVisibility(params?.serverId ?? params?.mcpId, params?.toolName, params?.visible));
ipcMain.handle('mcp:test-connection', async (_, params) => {
  const server = params?.serverId || params?.mcpId ? mcpRegistry.getServer(params.serverId ?? params.mcpId) : params;
  if (!server) throw new Error(`MCP server not found: ${params?.serverId ?? params?.mcpId ?? ''}`);
  const result = await testMcpConnection(server, { credentialResolver: mcpCredentialResolver });
  if (params?.serverId || params?.mcpId) mcpRegistry.updateHealth(server.id, result.health);
  return result;
});
ipcMain.handle('mcp:refresh-manifest', async (_, params) => {
  const server = mcpRegistry.getServer(params?.serverId ?? params?.mcpId);
  if (!server) throw new Error(`MCP server not found: ${params?.serverId ?? params?.mcpId ?? ''}`);
  const probe = await probeMcpConnection(server, { credentialResolver: mcpCredentialResolver });
  const view = persistMcpProbeResult(server.id, probe);
  disconnectMcp(mcpRegistry.getServer(server.id));
  return createMcpProbeResponse(probe, view);
});
ipcMain.handle('mcp:start-oauth', async (_, params) => {
  const serverId = params?.serverId ?? params?.mcpId;
  const server = mcpRegistry.getServer(serverId);
  if (!server) throw new Error(`MCP server not found: ${serverId ?? ''}`);
  // 一键 OAuth：先挂起 loopback 回调监听，再触发授权发现并打开系统浏览器。
  const callbackPromise = waitForMcpOAuthCallback();
  let start;
  try {
    start = await startMcpOAuth(server, { credentialResolver: mcpCredentialResolver });
  } catch (error) {
    closeMcpOAuthCallback();
    throw error;
  }
  // 已持有有效 token（无需浏览器交互）：直接收尾，重新探测并持久化 manifest/health。
  if (start?.status === 'authorized' || start?.redirected === false) {
    closeMcpOAuthCallback();
    const probe = await probeMcpConnection(server, { credentialResolver: mcpCredentialResolver });
    const view = persistMcpProbeResult(server.id, probe);
    disconnectMcp(mcpRegistry.getServer(server.id));
    return { ...createMcpProbeResponse(probe, view), oauth: 'authorized' };
  }
  // 已打开浏览器：等待用户在浏览器完成授权后 loopback 回调带回的 code，再交换 token。
  const code = await callbackPromise;
  await finishMcpOAuth(server, code, { credentialResolver: mcpCredentialResolver });
  disconnectMcp(mcpRegistry.getServer(server.id));
  const probe = await probeMcpConnection(server, { credentialResolver: mcpCredentialResolver });
  const view = persistMcpProbeResult(server.id, probe);
  disconnectMcp(mcpRegistry.getServer(server.id));
  return { ...createMcpProbeResponse(probe, view), oauth: 'connected' };
});

ipcMain.handle('mcp:finish-oauth', async (_, params) => {
  const server = mcpRegistry.getServer(params?.serverId ?? params?.mcpId);
  if (!server) throw new Error(`MCP server not found: ${params?.serverId ?? params?.mcpId ?? ''}`);
  const result = await finishMcpOAuth(server, params?.authorizationCode ?? params?.code, { credentialResolver: mcpCredentialResolver });
  disconnectMcp(server);
  return result;
});
ipcMain.handle('mcp:read-resource', async (_, params) => {
  const server = mcpRegistry.getServer(params?.serverId ?? params?.mcpId);
  if (!server) throw new Error(`MCP server not found: ${params?.serverId ?? params?.mcpId ?? ''}`);
  return readMcpResource(server, params?.uri, { credentialResolver: mcpCredentialResolver });
});
ipcMain.handle('mcp:get-prompt', async (_, params) => {
  const server = mcpRegistry.getServer(params?.serverId ?? params?.mcpId);
  if (!server) throw new Error(`MCP server not found: ${params?.serverId ?? params?.mcpId ?? ''}`);
  return getMcpPrompt(server, params?.name, params?.arguments ?? {}, { credentialResolver: mcpCredentialResolver });
});
ipcMain.handle('mcp:connect-and-register', async (_, { serverUrl, serverName }) => {
  if (!serverUrl || !serverName) throw new Error('serverUrl and serverName are required');
  const view = mcpRegistry.upsertServer({
    displayName: serverName,
    name: serverName,
    transport: 'streamable_http',
    url: serverUrl,
    serverUrl,
    auth: { mode: 'none' },
    enabled: true,
  });
  const server = mcpRegistry.getServer(view.id);
  const probe = await probeMcpConnection(server, { credentialResolver: mcpCredentialResolver });
  let refreshed = view;
  if (probe.state === 'connected' && probe.manifest) {
    refreshed = mcpRegistry.updateManifest(view.id, probe.manifest);
  } else {
    refreshed = mcpRegistry.updateHealth(view.id, probe.health);
  }
  disconnectMcp(mcpRegistry.getServer(view.id));
  return {
    ...probe,
    success: probe.state === 'connected',
    toolCount: probe.toolsCount,
    view: refreshed,
  };
});

// ── Local Tool Host ──
let localToolHost;
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

app.whenReady().then(async () => {
  setDockIcon();
  nativeTheme.on('updated', () => {
    const appearance = settingsStore.getAll().appearance;
    if (appearance?.mode !== 'system') return;
    setDockIcon(appearance);
    quickChatWindowController.getWindow()?.webContents.send('appearance:changed', appearance);
  });
  const userDataPath = dataHome;
  const disableLocalSkill = process.env.PEER_AGENT_DISABLE_LOCAL_SKILL === '1';
  // a1 公共 skill 仓（~/.agents/skills）作为「借用来源」：不再自动合并，只用于
  // listAvailableSkills 列举候选，用户显式 link 后才在 userData/skills 下建软链。
  const sourceRoots = [path.join(os.homedir(), '.agents', 'skills')];
  skillStore = disableLocalSkill ? null : createSkillStore({ userDataPath, sourceRoots });

  // 冷启动：shell 环境快照与首窗创建并行，不阻塞 createWindow。
  // buildShellSpawnArgs 在快照未就绪时会 fallback 到 login shell。
  void scheduleMissingPricingBackfill('startup');
  void createShellEnvSnapshot().catch((err) => {
    console.warn('[shell-env-snapshot] background create failed:', err?.message || err);
  });

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
    // 让 AI 工具路径（goal_create_plan / goal_update_task）与 IPC 路径共享同一个
    // goalPlanStore 实例，避免出现"两个实例指向同磁盘、需重挂载才同步"的 bug。
    goalProvider: createLocalGoalProvider({ goalPlanStore }),
    extraProviders: skillStore ? [createLocalSkillProvider({ skillStore })] : [],
    onRuntimeEvent: forwardRuntimeEvent,
  });
  flushPendingRuntimeEvents();

  ipcMain.handle('client-tool:execute', (_event, payload) => {
    if (!localToolHost) throw new Error('local_tool_host_not_ready');
    return localToolHost.execute(
      { call: payload?.call },
      { localApproval: payload?.grant, source: 'renderer_client_tool_polling' },
    );
  });
  ipcMain.handle('shell:tasks:list', () => localToolHost.listShellTasks());
  ipcMain.handle('shell:tasks:stop-active', () => localToolHost.stopActiveShellTask());
  ipcMain.handle('shell:tasks:stop', (_event, payload) => localToolHost.stopShellTask(payload?.taskId || payload?.toolCallId));
  ipcMain.handle('shell:permissions:list', () => localToolHost.permissionReview.listShellRules());
  ipcMain.handle('shell:permissions:add', (_event, payload) => localToolHost.permissionReview.addShellRule(payload));

  // ── Skills (local only) ──
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
  // ── 从 a1 公共仓借用技能（软链投影）──
  ipcMain.handle('skills:list-available', () => skillStore?.listAvailableSkills() ?? []);
  ipcMain.handle('skills:link', (_event, { skillId }) => {
    if (!skillStore) throw new Error('skill_store_not_available');
    return skillStore.linkSkill(skillId);
  });
  ipcMain.handle('skills:unlink', (_event, { skillId }) => {
    if (!skillStore) throw new Error('skill_store_not_available');
    return skillStore.unlinkSkill(skillId);
  });

  createWindow();

  // 任务完成系统通知 Broker：订阅 goalPlans 变更、去重、前台抑制、点击回流。
  try {
    taskNotificationBroker = createTaskNotificationBroker({
      getPlan: (planId) => goalPlanStore.getPlan(planId),
      listPlans: () => goalPlanStore.listPlanDetails(),
      getSettings: () => settingsStore.getAll(),
      isAppForeground: () => isMainAppForegroundForNotifications(),
      getActiveConversationId: () => activeConversationIdForNotifications,
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

// 退出前清理自动更新周期检测定时器，避免定时器泄漏。
app.on('before-quit', () => {
  stopConversationChangeSubscription();
  stopGoalPlanChangeSubscription();
  shortcutService.dispose();
  try {
    stopAutoUpdater();
  } catch (err) {
    console.error('[updater] stop failed:', err);
  }
});
