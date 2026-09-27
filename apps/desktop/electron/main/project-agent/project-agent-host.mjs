import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';

import {
  createApprovalStore,
  createBotDirectory,
  createBotLifecycle,
  createBotProfileStore,
  createInputQueue,
  createMemoryStore,
  createDigestQueue,
  createProjectAgentRunner,
  inQuietHours,
  createProjectInbox,
  normalizeProjectAgentSettings,
  createProjectRegistry,
  createSessionSupervisor,
  resolveRoleRoute,
} from '@peer-agent/runtime-node';
import { createBroadcastSink } from '../agent-host/turn-sinks.mjs';
import { createProjectAgentApplicationService } from './project-agent-application-service.mjs';
import { createManagedFolder } from './managed-folder.mjs';
import { evidenceBodyFromRecord } from './evidence-presenter.mjs';
import { createProjectAgentIpcRegistrations } from '../ipc/register-project-agent-ipc.mjs';
import { installSessionVerification, createSessionVerification } from './session-verification.mjs';
import { installProjectProactivity } from './proactivity-port.mjs';
import { installDeliveryFacts } from './delivery-facts-port.mjs';
import { resolveArtifactOpenPath } from '../task-overview-aggregator.mjs';

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
  readSettings = null,
  digestQueue = null,
  schedule = null,
  clearSchedule = null,
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
  const digests = digestQueue || createDigestQueue({
    file: rootDir ? path.join(rootDir, 'digest-queue.json') : null,
  });

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
      onDigest: (item) => digests.hold(workspaceId, item),
      onDigestDelivered: (message) => {
        const date = message?.meta?.digestDate;
        if (typeof date === 'string') digests.acknowledge(workspaceId, date);
      },
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
      const due = armDigest(runner, workspaceId);
      const consumed = queue.consume(workspaceId);
      if (consumed.consumed?.length) runs.push(runner.enqueueUserInputs(consumed.consumed));
      else if (!consumed.skipped || due) runs.push(runner.kick());
    }
    await Promise.all(runs);
    return { workspaces: wanted.map((item) => item.workspaceId) };
  }

  function armDigest(runner, workspaceId) {
    if (typeof readSettings !== 'function') return false;
    const settings = normalizeProjectAgentSettings(readSettings()?.projectAgent);
    const at = typeof now === 'function' ? now() : new Date();
    const due = digests.consider(workspaceId, at, settings.digestTime);
    if (!due?.timer) return false;
    const queued = runner.enqueueTimer(due.timer);
    return queued?.queued === true;
  }

  async function deliverDigests() {
    const settings = normalizeProjectAgentSettings(
      typeof readSettings === 'function' ? readSettings()?.projectAgent : null,
    );
    const at = typeof now === 'function' ? now() : new Date();
    const listed = listWorkspaceIds();
    const seen = new Set();
    const runs = [];
    for (const workspaceId of listed) {
      if (typeof workspaceId !== 'string' || seen.has(workspaceId)) continue;
      seen.add(workspaceId);
      if (holdsLease(workspaceId) !== true) continue;
      const conversationId = resolveConversationId(workspaceId);
      if (typeof conversationId !== 'string' || !conversationId.trim()) continue;
      const preview = digests.consider(workspaceId, at, settings.digestTime);
      if (!preview?.timer && !runners.has(workspaceId)) continue;
      const runner = ensureRunner(workspaceId, conversationId.trim());
      const due = armDigest(runner, workspaceId);
      const waiting = runner.mailbox().timers.some((timer) => timer?.kind === 'digest_due' && timer.wake === true);
      if (due || waiting) runs.push(runner.kick());
    }
    await Promise.all(runs);
  }

  const useSchedule = typeof schedule === 'function' ? schedule : setTimeout;
  const useClearSchedule = typeof clearSchedule === 'function' ? clearSchedule : clearTimeout;
  let digestHandle = null;
  let hostDisposed = false;

  function clearDigestHandle() {
    if (digestHandle == null) return;
    useClearSchedule(digestHandle);
    digestHandle = null;
  }

  function nextDigestDelay() {
    const settings = normalizeProjectAgentSettings(
      typeof readSettings === 'function' ? readSettings()?.projectAgent : null,
    );
    const at = typeof now === 'function' ? now() : new Date();
    const date = at instanceof Date ? new Date(at.getTime()) : new Date(at);
    if (Number.isNaN(date.getTime())) return 60_000;
    const [hour, minute] = settings.digestTime.split(':').map((part) => Number(part));
    const next = new Date(date);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= date.getTime()) next.setDate(next.getDate() + 1);
    return Math.max(1000, next.getTime() - date.getTime());
  }

  function planDigestClock(delay) {
    clearDigestHandle();
    if (hostDisposed || typeof readSettings !== 'function') return;
    digestHandle = useSchedule(() => {
      digestHandle = null;
      return Promise.resolve()
        .then(() => deliverDigests())
        .catch(() => {})
        .finally(() => {
          if (!hostDisposed) planDigestClock(nextDigestDelay());
        });
    }, delay);
  }

  if (typeof readSettings === 'function') planDigestClock(0);

  function dispose() {
    hostDisposed = true;
    clearDigestHandle();
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
  const approvalStore = createApprovalStore({ rootDir: runtimeRoot });
  const profileStore = createBotProfileStore({ rootDir: dataHome });
  const supervisor = createSessionSupervisor({
    conversationStore,
    goalPlanStore,
    goalRunner,
    approvalStore,
    readPlanApproval: (workspaceId) => profileStore.read(workspaceId)?.planApproval,
  });
  installSessionVerification(createSessionVerification({
    goalPlanStore,
    verifySession: (plan, focus) => goalRunner?.verifyDelegatedSession?.({ plan, focus }),
    appendMessage,
  }));
  installDeliveryFacts({
    read(view) {
      const settings = normalizeProjectAgentSettings(getSettings()?.projectAgent);
      const level = profileStore.read(view?.workspaceId)?.proactivity;
      return {
        proactivity: settings.proactivity,
        ...(typeof level === 'string' && level !== 'inherit' ? { botLevel: level } : {}),
        quietHours: inQuietHours(new Date(), settings.quietHours),
      };
    },
  });
  installProjectProactivity({
    set({ workspaceId, level }) {
      const profile = profileStore.read(workspaceId);
      if (!profile || profile.status === 'archived') return { ok: false, error: 'not_found' };
      const saved = profileStore.save({ ...profile, proactivity: level });
      if (!saved?.ok) return { ok: false, error: saved?.code || 'save_failed' };
      return { ok: true, level };
    },
  });
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
    readSettings: getSettings,
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
    readEvidenceBody(evidenceRef) {
      if (typeof goalPlanStore?.findEvidenceIndexRecords !== 'function') return null;
      let records = [];
      try {
        records = goalPlanStore.findEvidenceIndexRecords([evidenceRef]) || [];
      } catch {
        return null;
      }
      const record = records[0];
      if (!record) return null;
      const body = evidenceBodyFromRecord(record, (ref) => readRegisteredArtifact(dataHome, ref, record));
      if (!body?.text) return null;
      return { evidenceRef, kind: body.kind, text: body.text };
    },
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
    agentOnline: (workspaceId) => typeof holdsLease === 'function' && holdsLease(workspaceId) === true,
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

function readRegisteredArtifact(dataHome, ref, record) {
  if (typeof ref !== 'string' || !/^local-(?:shell|browser)-artifact:\/\//.test(ref)) return '';
  const target = resolveArtifactOpenPath(ref, {
    shell: path.join(dataHome, 'shell-artifacts'),
    browser: path.join(dataHome, 'browser-artifacts'),
  }, record?.createdAt);
  if (!target) return '';
  try {
    if (statSync(target).isDirectory() || /\.(png|jpe?g|webp|gif)$/i.test(target)) return ref;
    return readFileSync(target, 'utf8');
  } catch {
    return '';
  }
}
