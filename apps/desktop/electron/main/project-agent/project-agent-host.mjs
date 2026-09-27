import path from 'node:path';

import {
  createApprovalStore,
  createBotDirectory,
  createBotLifecycle,
  createBotProfileStore,
  createInputQueue,
  createMemoryStore,
  createProjectAgentRunner,
  createProjectInbox,
  createProjectRegistry,
  createSessionSupervisor,
  resolveRoleRoute,
} from '@peer-agent/runtime-node';
import { createBroadcastSink } from '../agent-host/turn-sinks.mjs';
import { createProjectAgentApplicationService } from './project-agent-application-service.mjs';
import { createManagedFolder } from './managed-folder.mjs';
import { createProjectAgentIpcRegistrations } from '../ipc/register-project-agent-ipc.mjs';

/**
 * 桌面装配：只为当前进程持有租约、并且已经有代理对话的项目创建 runner。
 * main / IPC 在 B2-13 接入。输入从 consume() 的返回值入队，不再听 onCommitted。
 */
export function createProjectAgentHost({
  rootDir = null,
  holdsLease = () => false,
  listWorkspaceIds = () => [],
  resolveConversationId = () => '',
  hasMessage = () => false,
  appendMessage = () => {},
  executeTurn,
  resolveModel = null,
  resolveContext = null,
  routing = null,
  getWindows = () => [],
  now,
  retryDelays,
  inbox = null,
  inputQueue = null,
} = {}) {
  if (typeof executeTurn !== 'function') {
    throw new TypeError('ProjectAgentHost requires executeTurn');
  }
  const inboxStore = inbox || createProjectInbox({ rootDir, now });
  const queue = inputQueue || createInputQueue({
    rootDir,
    now,
    holdsLease,
    resolveConversationId,
    hasMessage,
    appendMessage,
  });
  const runners = new Map();

  function resolveTurnModel(workspaceId, conversationId) {
    if (typeof resolveModel === 'function') {
      return resolveModel({ workspaceId, conversationId, role: 'project_agent' });
    }
    return resolveRoleRoute({
      role: 'project_agent',
      providers: routing?.providers,
      routing: routing?.routing,
      projectPolicy: routing?.projectPolicy,
      spentUsd: routing?.spentUsd,
    });
  }

  function drop(workspaceId) {
    const runner = runners.get(workspaceId);
    if (!runner) return;
    runner.dispose();
    runners.delete(workspaceId);
  }

  function ensureRunner(workspaceId, conversationId) {
    const existing = runners.get(workspaceId);
    if (existing && existing.conversationId === conversationId) return existing;
    if (existing) drop(workspaceId);
    const runner = createProjectAgentRunner({
      workspaceId,
      conversationId,
      inbox: inboxStore,
      holdsLease: () => holdsLease(workspaceId) === true,
      executeTurn,
      appendMessage,
      resolveModel: () => resolveTurnModel(workspaceId, conversationId),
      resolveContext: (info) => (
        typeof resolveContext === 'function'
          ? resolveContext({ ...info, workspaceId, conversationId })
          : null
      ),
      sink: createBroadcastSink({ getWindows }),
      now,
      retryDelays,
    });
    runners.set(workspaceId, runner);
    return runner;
  }

  async function sync(workspaceIds) {
    const listed = Array.isArray(workspaceIds) ? workspaceIds : listWorkspaceIds();
    const wanted = [];
    const seen = new Set();
    for (const workspaceId of listed) {
      if (typeof workspaceId !== 'string' || seen.has(workspaceId)) continue;
      seen.add(workspaceId);
      if (holdsLease(workspaceId) !== true) continue;
      const conversationId = resolveConversationId(workspaceId);
      if (typeof conversationId !== 'string' || !conversationId.trim()) continue;
      wanted.push({ workspaceId, conversationId: conversationId.trim() });
    }
    const wantedIds = new Set(wanted.map((item) => item.workspaceId));
    for (const workspaceId of [...runners.keys()]) {
      if (!wantedIds.has(workspaceId)) drop(workspaceId);
    }
    const runs = [];
    for (const { workspaceId, conversationId } of wanted) {
      const runner = ensureRunner(workspaceId, conversationId);
      const consumed = queue.consume(workspaceId);
      if (consumed.consumed?.length) runs.push(runner.enqueueUserInputs(consumed.consumed));
      else if (!consumed.skipped) runs.push(runner.kick());
    }
    await Promise.all(runs);
    return { workspaces: wanted.map((item) => item.workspaceId) };
  }

  function dispose() {
    for (const workspaceId of [...runners.keys()]) drop(workspaceId);
  }

  return {
    sync,
    dispose,
    runnerFor: (workspaceId) => runners.get(workspaceId) ?? null,
    inbox: inboxStore,
    inputQueue: queue,
  };
}

export function registerDesktopProjectAgent({
  enabled,
  dataHome,
  conversationStore,
  goalPlanStore,
  goalRunner,
  agentTurnExecutor,
  workspace,
  broadcast,
  holdsLease,
  getSettings,
  mergeSettings,
  dialog,
  BrowserWindow,
  shell,
  onReady = null,
  onAppendedMessage = null,
  onViewing = null,
} = {}) {
  const runtimeRoot = path.join(dataHome, 'project-runtime');
  const registry = createProjectRegistry({
    filePath: path.join(dataHome, 'projects', 'registry.json'),
  });
  const supervisor = createSessionSupervisor({
    conversationStore,
    goalPlanStore,
    goalRunner,
  });
  const approvalStore = createApprovalStore({ rootDir: runtimeRoot });
  const directory = createBotDirectory({
    rootDir: dataHome,
    registry,
    readMessages: (conversationId) => (
      conversationStore.getPersistedConversationHistory(conversationId)?.messages || []
    ),
    listSessions: (workspaceId) => supervisor.list({ workspaceId }),
    getSession: (sessionId) => supervisor.get({ sessionId }),
    listApprovals: (workspaceId) => approvalStore.list({ workspaceId }),
  });
  const lifecycle = createBotLifecycle({
    rootDir: dataHome,
    enabled,
    registry,
    conversationStore,
    memoryStore: createMemoryStore({ rootDir: dataHome }),
    removeWorkspace: (folder) => workspace.removeWorkspace(folder),
    moveToTrash: (folder) => shell.trashItem(folder),
  });
  const profileStore = createBotProfileStore({ rootDir: dataHome });

  function resolveConversationId(workspaceId) {
    return directory.conversationId(workspaceId);
  }

  function hasMessage(conversationId, messageId) {
    const history = conversationStore.getPersistedConversationHistory(conversationId);
    return history?.messages?.some((message) => message?.id === messageId) === true;
  }

  function appendMessage(conversationId, message) {
    conversationStore.appendMessage(conversationId, message);
    if (typeof onAppendedMessage !== 'function') return;
    try {
      onAppendedMessage({ conversationId, message });
    } catch (error) {
      console.warn('[project-agent-notifier] append hook failed:', error);
    }
  }

  function workspaceIdForConversation(conversationId) {
    const id = typeof conversationId === 'string' ? conversationId : '';
    if (!id) return '';
    for (const workspaceId of directory.workspaceIds()) {
      if (directory.conversationId(workspaceId) === id) return workspaceId;
    }
    return '';
  }

  const inputQueue = createInputQueue({
    rootDir: runtimeRoot,
    holdsLease,
    resolveConversationId,
    hasMessage,
    appendMessage,
  });
  const host = createProjectAgentHost({
    rootDir: runtimeRoot,
    holdsLease,
    listWorkspaceIds: () => directory.workspaceIds(),
    resolveConversationId,
    hasMessage,
    appendMessage,
    executeTurn: (input) => agentTurnExecutor.runTurn(input),
    inputQueue,
    getWindows: () => BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()),
  });
  const projectAgent = createProjectAgentApplicationService({
    enabled,
    directory,
    lifecycle,
    profileStore,
    inputQueue,
    sessions: supervisor,
    approvals: approvalStore,
    bindWorkspace: (sender) => workspace.addWorkspace(sender),
    rememberWorkspace({ workspaceId, path: folder, name }) {
      const settings = getSettings() || {};
      const workspaces = Array.isArray(settings.workspaces) ? [...settings.workspaces] : [];
      if (workspaces.some((item) => item?.path === folder || item?.id === workspaceId)) return;
      mergeSettings({
        workspaces: [...workspaces, {
          id: workspaceId,
          path: folder,
          name,
          addedAt: new Date().toISOString(),
          linkedFolders: [],
        }],
        activeWorkspace: folder,
      });
    },
    createManaged: (name) => createManagedFolder({
      name,
      managedRoot: getSettings()?.projectAgent?.managedRoot || null,
      registry,
    }),
    chooseAvatar: async (sender) => {
      const parent = sender ? BrowserWindow.fromWebContents(sender) : undefined;
      const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
        title: '选择头像',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      return canceled ? null : (filePaths?.[0] ?? null);
    },
    wake: (workspaceId) => {
      void host.sync([workspaceId]).catch(() => {});
    },
    onViewing,
    broadcast,
  });
  if (typeof onReady === 'function') {
    onReady({
      listItems: () => directory.list(),
      botName: (workspaceId) => {
        const got = directory.get(workspaceId);
        if (!got?.ok) return '';
        return got.profile?.displayName || got.item?.profile?.displayName || '';
      },
      workspaceIdForConversation,
    });
  }
  return createProjectAgentIpcRegistrations({ projectAgent });
}
