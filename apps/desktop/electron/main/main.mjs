import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { createCapabilityRegistry } from './capability-registry.mjs';
import { loadLocalEnv } from './env-loader.mjs';
import { runHealthStub } from './core-health.mjs';
import { readProjectIndex } from './project-index.mjs';
import { createSessionStore, resolveLocalAccessLevel } from './session-store.mjs';
import { createLocalToolHost } from './runtime-gateway/local-tool-host.mjs';
import { createLocalShellProvider } from './runtime-gateway/local-shell-provider.mjs';
import { createLocalSkillProvider } from './runtime-gateway/local-skill-provider.mjs';
import { createSkillStore } from './skill-store.mjs';
import { createShellEnvSnapshot } from './runtime-gateway/shell-env-snapshot.mjs';
import { getDataHome, migrateFromLegacy, exportBundle, importBundle } from './data-store.mjs';
import { createSettingsStore } from './settings-store.mjs';
import { createMcpRegistry } from './mcp-registry.mjs';
import { createMcpCredentialResolver, createMcpCredentialStore } from './mcp-credential-store.mjs';
import { disconnectMcp, discoverMcpManifest, getMcpPrompt, readMcpResource, testMcpConnection } from './mcp-client.mjs';
import { createLlmConfigStore } from './llm-config-store.mjs';
import { listChannelDescriptors, resolveChannel } from './provider-channels.mjs';
import { startBrowserLogin, ensureFreshTokens } from './llm-oauth/openai-oauth.mjs';
import { startGoogleBrowserLogin, ensureFreshGoogleTokens } from './llm-oauth/google-oauth.mjs';
import { listSubscriptionModels } from './provider-adapters/openai-model-catalog.mjs';
import { listGeminiModels } from './provider-adapters/gemini-model-catalog.mjs';
import { createHostRestarter } from './host-restart.mjs';
import { clearPendingTask, peekPendingTask, readAndClearPendingTask, writePendingTask } from './pending-task-store.mjs';
import { createLlmChatService } from './llm-chat-service.mjs';
import { buildSystemContext, renderSystemContext } from './llm-prompts.mjs';
import { createContextBaselineRecorder } from './prompt/context-baseline-recorder.mjs';
import { createPromptSnapshotStore } from './prompt/prompt-snapshot-store.mjs';
import { createConversationStore } from './conversation-store.mjs';
import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createGoalRunner } from './goal-runner.mjs';
import { createLocalGoalProvider } from './runtime-gateway/local-goal-provider.mjs';
import { buildPersistedCompactedMessages } from './conversation-compaction-persistence.mjs';
import { compactIfNeeded } from './context-compactor.mjs';
import {
  beginCompaction,
  endCompaction,
  updateCompactionProgress,
  getCompaction,
} from './chat-runtime/compaction-registry.mjs';
import { resolveProviderCredential } from './provider-credential-resolver.mjs';
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
const mcpCredentialResolver = createMcpCredentialResolver(mcpCredentialStore);
const llmConfigStore = createLlmConfigStore();
const conversationStore = createConversationStore();
const goalPlanStore = createGoalPlanStore({
  // 任何写路径（IPC 或 AI 工具 local-goal-provider）改动计划后，广播给所有窗口，
  // 让 GoalPlanPanel 实时重拉，无需切换会话/重挂载。详见方案 B。
  // broadcastToAllWindows 是后文的函数声明（已提升），onChange 仅在运行时触发，引用安全。
  onChange: (payload) => broadcastToAllWindows('goalPlans:changed', payload),
});
let goalRunner = null;
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
  return conversationStore.replaceMessages(conversationId, compactedMessages);
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

function continuityContextFromMessages(messages = []) {
  return messages
    .filter((message) => message?._compaction)
    .map((message, index) => {
      const handoff = message._compaction;
      return {
        id: `conversation-compact:${message.id || index}`,
        method: handoff.method || 'unknown',
        originalMessageCount: handoff.originalMessageCount ?? 0,
        beforeTokens: handoff.beforeTokens ?? 0,
        afterTokens: handoff.afterTokens ?? 0,
        summary: handoff.summary || message.content || '',
      };
    });
}

// 向所有渲染窗口广播一个事件(用于全局活跃流状态等不绑定单一 streamId 的通知)。
function broadcastToAllWindows(channel, payload) {
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function getRunnerWebContents() {
  const wins = BrowserWindow.getAllWindows();
  return wins.find((win) => !win.isDestroyed())?.webContents ?? null;
}

function toRuntimeMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : '',
    }));
}

function buildGoalRunnerMessage(plan, turnNumber) {
  const planLabel = plan?.title || plan?.goal || plan?.planId || 'goal';
  return `Goal Runner tick ${turnNumber} for plan "${planLabel}" (planId=${plan?.planId || 'unknown'}). Continue from the approved GoalPlan state.`;
}

function buildGoalRunnerReminder(plan, turnNumber) {
  return {
    id: `goal-runner-${plan?.planId || 'unknown'}-${turnNumber}`,
    title: 'Goal Runner execution contract',
    kind: 'goal-runner',
    scope: 'turn',
    layer: 'L6_MODE_REMINDER',
    content: 'Continue autonomously within the approved goal, boundaries, and success criteria. Use the existing tools and permission flow; when a subtask is completed, update it through the goal task evidence path. If you need user input, permission, or evidence is insufficient, stop and explain the blocker instead of pretending completion.',
  };
}

function buildExplorerMessage({ plan, explorer }) {
  const request = explorer?.request || {};
  return `Explorer mission for plan "${plan?.title || plan?.goal || plan?.planId || 'goal'}".
Question: ${request.question || 'Explore missing evidence for the active goal'}
Reason: ${request.reason || 'The Goal Runner needs more evidence before continuing.'}
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
Return a concise JSON object only with: summary, findings[{claim,evidenceRefs}], evidenceRefs, recommendedNextStep, confidence(low|medium|high).`,
  };
}

function createCollectingWebContents() {
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
      broadcastToAllWindows('goalRunner:changed', {
        type: 'goalRunner:streamStarted',
        planId: plan.planId,
        conversationId: plan.conversationId,
        streamId,
        turnNumber,
        startedAt: Date.now(),
      });
      const messages = [
        ...toRuntimeMessages(conversation.messages),
        { role: 'user', content: buildGoalRunnerMessage(plan, turnNumber) },
      ];
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
      const agentProgress = {
        onRound: () => bumpRunnerCount('roundCount'),
        onToolCall: () => bumpRunnerCount('toolCallCount'),
      };
      await llmChatService.sendMessage({
        messages,
        webContents,
        streamId,
        effort: 'default',
        mode: 'goal',
        conversationId: plan.conversationId,
        runtimeReminders: [buildGoalRunnerReminder(plan, turnNumber)],
        agentProgress,
      });
      return { continue: false, intent: 'verify' };
    },
  },
  explorerRunner: {
    async runExplorer({ plan, explorer }) {
      const streamId = randomUUID();
      const webContents = createCollectingWebContents();
      broadcastToAllWindows('goalRunner:changed', {
        type: 'goalRunner:explorerStreamStarted',
        planId: plan.planId,
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
        conversationId: plan.conversationId,
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
      if (report.evidenceRefs.length === 0) {
        report.evidenceRefs = [`goal-explorer://${explorer.explorerId}/stream/${streamId}`];
      }
      report.toolCallCount = webContents
        .getEvents()
        .filter((event) => event.channel === 'chat:stream:tool-call')
        .length;
      return report;
    },
  },
  emitEvent: (payload) => broadcastToAllWindows('goalRunner:changed', payload),
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

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1040,
    minHeight: 720,
    title: 'Peer Agent',
    backgroundColor: '#1e1e2e',
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
  projects: readProjectIndex({ workspaceRoot: resourcesRoot }),
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

// ── Locale ──
ipcMain.handle('locale:set', (_event, payload) => {
  sessionStore.setLocale(payload.locale);
  settingsStore.merge({ locale: payload.locale });
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

// ── Core Health ──
ipcMain.handle('core:health', (_event, payload) => {
  const capability = capabilityRegistry.findCapability('local.health');
  if (!capability) {
    return {
      toolCallId: payload.toolCallId,
      status: 'failed',
      outputPreview: { status: 'capability_not_registered', capabilityId: 'local.health' },
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

// ── Workspace ──
ipcMain.handle('workspace:list', () => {
  const all = settingsStore.getAll();
  return { workspaces: all.workspaces || [], activeWorkspace: all.activeWorkspace || null };
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
    return { path: dir, name, existing: true };
  }
  workspaces.push({ path: dir, name, addedAt: new Date().toISOString() });
  settingsStore.merge({ workspaces, activeWorkspace: dir });
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
    if (existsSync(target)) return { exists: true };
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
        if (existsSync(path.normalize(path.join(ws, cleanRel)))) {
          return { exists: true, resolvedFrom: ws };
        }
      }
    }
    return { exists: false };
  } catch {
    return { exists: false };
  }
});

// ── Conversations ──
ipcMain.handle('conversations:list', (_, params) => {
  const listParams = { status: params?.status };
  if (params?.workspacePath !== undefined) return conversationStore.listConversationsByWorkspace(params.workspacePath, listParams);
  return conversationStore.listConversations(listParams);
});
ipcMain.handle('conversations:create', (_, params) => conversationStore.createConversation(params));
ipcMain.handle('conversations:get', (_, { id }) => conversationStore.getConversation(id));
ipcMain.handle('conversations:update-title', (_, { id, title }) => conversationStore.updateTitle(id, title));
ipcMain.handle('conversations:update-mode', (_, { id, mode }) => conversationStore.updateMode(id, mode));
ipcMain.handle('conversations:append-message', (_, { id, message }) => conversationStore.appendMessage(id, message));
ipcMain.handle('conversations:update-last-message', (_, { id, content }) => conversationStore.updateLastMessage(id, content));
ipcMain.handle('conversations:replace-messages', (_, { id, messages }) => conversationStore.replaceMessages(id, messages));
ipcMain.handle('conversations:archive', (_, { id }) => conversationStore.archiveConversation(id));
ipcMain.handle('conversations:restore', (_, { id }) => conversationStore.restoreConversation(id));
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
  return result;
});
// 累计计费账本:独立于消息/压缩,累加到 index meta 的 lifetimeUsage(见 ADR 23)。
// 压缩(replace-messages)只重写消息文件,不碰 meta,故 lifetimeUsage 不受压缩影响。
ipcMain.handle('conversations:add-usage', (_, { id, usage }) => conversationStore.addUsage(id, usage));

// ── Goal Plans（goal 模式：先规划 → 批准 → 执行，计划为持久化 Evidence/artifact）──
// 见 Goal 模式设计。progress 由 store 自底向上聚合，调用方不可手填。
ipcMain.handle('goalPlans:list', (_, params) => {
  if (params?.conversationId !== undefined) return goalPlanStore.listPlanDetailsByConversation(params.conversationId);
  return goalPlanStore.listPlanDetails();
});
ipcMain.handle('goalPlans:get', (_, { planId }) => goalPlanStore.getPlan(planId));
ipcMain.handle('goalPlans:create', (_, { draft }) => goalPlanStore.createPlan(draft));
ipcMain.handle('goalPlans:revise', (_, { planId, patch, reason, changedBy }) =>
  goalPlanStore.revisePlan(planId, patch, { reason, changedBy }));
ipcMain.handle('goalPlans:approve', (_, { planId, approval }) => {
  const plan = goalPlanStore.recordApproval(planId, approval);
  if (approval?.decision === 'approve') {
    void goalRunner?.start(planId);
  }
  return plan;
});
ipcMain.handle('goalPlans:set-status', (_, { planId, status }) => goalPlanStore.setPlanStatus(planId, status));
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
ipcMain.handle('chat:send', (event, {
  messages,
  streamId,
  effort,
  mode,
  conversationId,
  assistantMessageId,
  contextAttachments,
  runtimeReminders,
  attachmentContext,
  continuityContext,
  configInstructions,
  contextExtensions,
}) =>
  llmChatService.sendMessage({
    messages,
    webContents: event.sender,
    streamId,
    effort,
    mode,
    conversationId,
    assistantMessageId,
    contextAttachments,
    runtimeReminders,
    attachmentContext,
    continuityContext,
    configInstructions,
    contextExtensions,
  }));
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
  const priorContinuityContext = continuityContextFromMessages(filteredMessages);
  const activeMessages = filteredMessages.filter((m) => !m?._compaction);
  if (activeMessages.length === 0) return { compacted: false };

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
    ...activeMessages.map((m) => ({ role: m.role, content: m.content })),
  ];

  // 登记表与事件 emit 单一来源：先登记会话压缩态再 emit start，
  // 使切会话查询（chat:compaction:get）能恢复手动 /compact 的横幅。
  beginCompaction({ conversationId, streamId, manual: true });
  event.sender.send('chat:compaction', { streamId, stage: 'start', manual: true });
  // 字符级真实进度：压缩器流式收摘要时逐 chunk 回调，转发为 progress 事件。
  let lastSentPercent = -1;
  const onProgress = ({ receivedChars, estimatedTotalChars }) => {
    const total = estimatedTotalChars > 0 ? estimatedTotalChars : 1;
    const percent = Math.min(99, Math.round((receivedChars / total) * 100));
    // 节流：百分比无变化时不重复发，减少 IPC 噪声。
    if (percent === lastSentPercent) return;
    lastSentPercent = percent;
    updateCompactionProgress({ conversationId, streamId, percent });
    event.sender.send('chat:compaction', {
      streamId,
      stage: 'progress',
      manual: true,
      receivedChars,
      estimatedTotalChars,
      percent,
    });
  };
  const result = await compactIfNeeded({
    messages: apiMessages,
    systemPrompt,
    contextWindow,
    providerConfig,
    force: true,
    continuityContext: priorContinuityContext,
    onProgress,
    webContents: event.sender,
    streamId,
  });

  if (!result.compacted) {
    endCompaction({ conversationId, streamId });
    event.sender.send('chat:compaction', { streamId, stage: 'idle', manual: true });
    return { compacted: false };
  }

  persistCompactionToConversation({
    conversationId,
    compactResult: result,
    sourceMessages: activeMessages,
  });

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

  // 无论是否有 notification，压缩已结束，先清登记表再 emit done，保证可查询真值收尾。
  endCompaction({ conversationId, streamId });
  if (result.notification) {
    event.sender.send('chat:compaction', { streamId, stage: 'done', manual: true, ...result.notification });
  }

  return { compacted: true, notification: result.notification };
});

// ── 压缩态查询（按 conversationId）──
// 渲染层切会话时调用：返回该会话当前是否正在压缩及进度，用于恢复横幅。
// 压缩态真值落在主进程登记表，渲染层只负责表达，不再各自持有运行真值。
ipcMain.handle('chat:compaction:get', (_event, { conversationId } = {}) =>
  getCompaction(conversationId));

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
ipcMain.handle('llm:list', () => llmConfigStore.listProviders());
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
ipcMain.handle('llm:remove', (_, { id }) => {
  const beforeDefault = llmConfigStore.listProviders().find((provider) => provider.isDefault) ?? null;
  const providers = llmConfigStore.removeProvider(id);
  const afterDefault = providers.find((provider) => provider.isDefault) ?? null;
  if (beforeDefault?.id === id && afterDefault) {
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

// ── Provider OAuth(ADR 28+) ──
// 同一时刻只允许一个进行中的 browser 登录会话,便于取消。
let activeOAuthLogin = null;

ipcMain.handle('llm:oauth:start', async (_event, params) => {
  // ADR 28: 订阅登录链路必须"先登录、成功后才落盘"。
  // - { id }   : 对已存在的订阅 provider 重新登录(刷新 token)。
  // - { draft }: 新建订阅。draft 是表单草稿,登录成功后才创建 provider;
  //              登录失败/取消则什么都不写入,绝不留下没有 token 的死配置。
  const id = params?.id ?? null;
  const draft = params?.draft ?? null;
  if (!id && !draft) throw new Error('provider id or draft required');
  const existing = id ? llmConfigStore.listProviders().find((provider) => provider.id === id) : null;
  const credential = id ? llmConfigStore.getCredential(id) : null;
  const authMethod = draft?.authMethod || existing?.authMethod || 'oauth_chatgpt';
  if (authMethod !== 'oauth_chatgpt' && authMethod !== 'oauth_google') {
    throw new Error(`unsupported_oauth_method:${authMethod}`);
  }
  if (activeOAuthLogin) {
    try { activeOAuthLogin.cancel(); } catch {}
    activeOAuthLogin = null;
  }
  const session = authMethod === 'oauth_google'
    ? startGoogleBrowserLogin({
      clientId: draft?.oauthClientId ?? credential?.oauthClientId,
      clientSecret: draft?.oauthClientSecret ?? credential?.oauthClientSecret,
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
    const provider = llmConfigStore.listProviders().find((p) => p.id === targetId) ?? null;
    if (provider) recordProviderBaseline('oauth_login', provider);
    return { success: true, provider };
  } catch (err) {
    // 若已创建了草稿 provider 但 token 写入失败,回滚以保持"失败不留痕"。
    if (createdId) {
      try { llmConfigStore.removeProvider(createdId); } catch {}
    }
    return { success: false, error: err?.message || 'oauth_login_failed' };
  } finally {
    if (activeOAuthLogin === session) activeOAuthLogin = null;
  }
});

ipcMain.handle('llm:oauth:cancel', () => {
  if (activeOAuthLogin) {
    try { activeOAuthLogin.cancel(); } catch {}
    activeOAuthLogin = null;
  }
  return { success: true };
});

// 登录后远程拉取可用模型(失败回退内置清单)。临近过期则刷新并回写 token。
ipcMain.handle('llm:models:list', async (_event, { id }) => {
  if (!id) throw new Error('provider id required');
  const credential = llmConfigStore.getCredential(id);
  const tokens = credential?.tokens || null;
  if (!tokens?.access) {
    return { success: false, models: [], error: 'oauth_not_logged_in' };
  }
  try {
    const provider = llmConfigStore.listProviders().find((p) => p.id === id) ?? null;
    const authMethod = credential?.authMethod || provider?.authMethod || 'oauth_chatgpt';
    const { tokens: fresh, refreshed } = authMethod === 'oauth_google'
      ? await ensureFreshGoogleTokens(tokens, {
        clientId: credential.oauthClientId,
        clientSecret: credential.oauthClientSecret,
      })
      : await ensureFreshTokens(tokens);
    if (refreshed) llmConfigStore.setOAuthTokens(id, fresh);
    const { models, source, error } = authMethod === 'oauth_google'
      ? await listGeminiModels(fresh, {
        projectId: credential.oauthProjectId,
        baseUrl: provider?.baseUrl,
      })
      : await listSubscriptionModels(fresh);
    return { success: true, models, source, error };
  } catch (err) {
    return { success: false, models: [], error: err?.message || 'models_list_failed' };
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
ipcMain.handle('mcp:uninstall', (_, params) => mcpRegistry.uninstall(params?.mcpId ?? params?.serverId));
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
  const manifest = await discoverMcpManifest(server, { credentialResolver: mcpCredentialResolver });
  const view = mcpRegistry.updateManifest(server.id, manifest);
  disconnectMcp(server);
  return { view, manifest };
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
    enabled: true,
  });
  const manifest = await discoverMcpManifest(mcpRegistry.getServer(view.id), { credentialResolver: mcpCredentialResolver });
  const refreshed = mcpRegistry.updateManifest(view.id, manifest);
  disconnectMcp(mcpRegistry.getServer(view.id));
  return { success: true, toolCount: manifest.tools.length, view: refreshed };
});

// ── Local Tool Host ──
let localToolHost;

app.whenReady().then(async () => {
  setDockIcon();
  const userDataPath = dataHome;
  const disableLocalSkill = process.env.PEER_AGENT_DISABLE_LOCAL_SKILL === '1';
  skillStore = disableLocalSkill ? null : createSkillStore({ userDataPath });

  await createShellEnvSnapshot();

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
    mcpCredentialResolver,
    shellProvider,
    // 让 AI 工具路径（goal_create_plan / goal_update_task）与 IPC 路径共享同一个
    // goalPlanStore 实例，避免出现"两个实例指向同磁盘、需重挂载才同步"的 bug。
    goalProvider: createLocalGoalProvider({ goalPlanStore }),
    extraProviders: skillStore ? [createLocalSkillProvider({ skillStore })] : [],
  });

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

  createWindow();

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
  try {
    stopAutoUpdater();
  } catch (err) {
    console.error('[updater] stop failed:', err);
  }
});
