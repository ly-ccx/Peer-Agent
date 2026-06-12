import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCapabilityRegistry } from './capability-registry.mjs';
import { loadLocalEnv } from './env-loader.mjs';
import { runHealthStub } from './core-health.mjs';
import { readProjectIndex } from './project-index.mjs';
import { createSessionStore } from './session-store.mjs';
import { createLocalToolHost } from './runtime-gateway/local-tool-host.mjs';
import { createLocalShellProvider } from './runtime-gateway/local-shell-provider.mjs';
import { createLocalSkillProvider } from './runtime-gateway/local-skill-provider.mjs';
import { createSkillStore } from './skill-store.mjs';
import { createShellEnvSnapshot } from './runtime-gateway/shell-env-snapshot.mjs';
import { getDataHome, migrateFromLegacy, exportBundle, importBundle } from './data-store.mjs';
import { createSettingsStore } from './settings-store.mjs';
import { createMcpRegistry } from './mcp-registry.mjs';
import { listMcpTools, disconnectMcp } from './mcp-client.mjs';
import { createLlmConfigStore } from './llm-config-store.mjs';
import { createHostRestarter } from './host-restart.mjs';
import { clearPendingTask, peekPendingTask, readAndClearPendingTask, writePendingTask } from './pending-task-store.mjs';
import { createLlmChatService } from './llm-chat-service.mjs';
import { buildSystemContext, renderSystemContext } from './llm-prompts.mjs';
import { createContextBaselineRecorder } from './prompt/context-baseline-recorder.mjs';
import { createPromptSnapshotStore } from './prompt/prompt-snapshot-store.mjs';
import { createConversationStore } from './conversation-store.mjs';
import { buildPersistedCompactedMessages } from './conversation-compaction-persistence.mjs';
import { compactIfNeeded } from './context-compactor.mjs';

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

const capabilityRegistry = createCapabilityRegistry({ workspaceRoot: resourcesRoot });
const sessionStore = createSessionStore({
  workspaceRoot: resourcesRoot,
  userDataPath: dataHome,
  listCapabilities: capabilityRegistry.listCapabilities,
  preferredLocale: settingsStore.getAll().locale ?? process.env.PEER_AGENT_LOCALE,
});

let skillStore;

const mcpRegistry = createMcpRegistry();
const llmConfigStore = createLlmConfigStore();
const conversationStore = createConversationStore();
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
  const keptCount = compactResult.notification?.keptMessageCount ?? 10;
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
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

const llmChatService = createLlmChatService({
  llmConfigStore,
  conversationStore,
  persistCompaction: persistCompactionToConversation,
  promptSnapshotStore,
  broadcast: broadcastToAllWindows,
});
llmChatService.setWorkspacePath(settingsStore.getAll().activeWorkspace || null);

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
  return next;
});
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

// ── Conversations ──
ipcMain.handle('conversations:list', (_, params) => {
  if (params?.workspacePath !== undefined) return conversationStore.listConversationsByWorkspace(params.workspacePath);
  return conversationStore.listConversations();
});
ipcMain.handle('conversations:create', (_, params) => conversationStore.createConversation(params));
ipcMain.handle('conversations:get', (_, { id }) => conversationStore.getConversation(id));
ipcMain.handle('conversations:update-title', (_, { id, title }) => conversationStore.updateTitle(id, title));
ipcMain.handle('conversations:append-message', (_, { id, message }) => conversationStore.appendMessage(id, message));
ipcMain.handle('conversations:update-last-message', (_, { id, content }) => conversationStore.updateLastMessage(id, content));
ipcMain.handle('conversations:replace-messages', (_, { id, messages }) => conversationStore.replaceMessages(id, messages));
ipcMain.handle('conversations:delete', (_, { id }) => conversationStore.deleteConversation(id));
// 累计计费账本:独立于消息/压缩,累加到 index meta 的 lifetimeUsage(见 ADR 23)。
// 压缩(replace-messages)只重写消息文件,不碰 meta,故 lifetimeUsage 不受压缩影响。
ipcMain.handle('conversations:add-usage', (_, { id, usage }) => conversationStore.addUsage(id, usage));

// ── LLM Chat ──
ipcMain.handle('chat:send', (event, {
  messages,
  streamId,
  effort,
  conversationId,
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
    conversationId,
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
  conversationIds: llmChatService.listActiveConversationIds(),
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

  const provider = llmConfigStore.listProviders().find((p) => p.isDefault && p.apiKeyConfigured)
    || llmConfigStore.listProviders().find((p) => p.apiKeyConfigured)
    || null;
  const apiKey = provider ? llmConfigStore.getDecryptedApiKey(provider.id) : null;
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

  const providerConfig = provider && apiKey
    ? { provider: provider.provider, baseUrl: provider.baseUrl, apiKey, model: provider.model }
    : null;
  const contextWindow = provider?.contextWindow || 0;

  const apiMessages = [
    { role: 'system', content: systemPrompt },
    ...activeMessages.map((m) => ({ role: m.role, content: m.content })),
  ];

  event.sender.send('chat:compaction', { streamId, stage: 'start', manual: true });
  const result = await compactIfNeeded({
    messages: apiMessages,
    systemPrompt,
    contextWindow,
    providerConfig,
    force: true,
    continuityContext: priorContinuityContext,
  });

  if (!result.compacted) {
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

  if (result.notification) {
    event.sender.send('chat:compaction', { streamId, stage: 'done', manual: true, ...result.notification });
  }

  return { compacted: true, notification: result.notification };
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
ipcMain.handle('mcp:install', (_, item) => mcpRegistry.install(item));
ipcMain.handle('mcp:uninstall', (_, params) => mcpRegistry.uninstall(params.mcpId));

function stableHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h) + 100000;
}

ipcMain.handle('mcp:connect-and-register', async (_, { serverUrl, serverName }) => {
  if (!serverUrl || !serverName) throw new Error('serverUrl and serverName are required');
  const tools = await listMcpTools(serverUrl);
  mcpRegistry.install({
    mcpId: stableHash(serverName),
    name: serverName,
    source: 'local',
    serverUrl,
    tools: tools.map((t) => ({ toolName: t.name, toolDesc: t.description })),
  });
  disconnectMcp(serverUrl);
  return { success: true, toolCount: tools.length };
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
    shellProvider,
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
