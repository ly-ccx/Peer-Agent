import {
  createInputQueue,
  createProjectAgentRunner,
  createProjectInbox,
  resolveRoleRoute,
} from '@peer-agent/runtime-node';
import { createBroadcastSink } from '../agent-host/turn-sinks.mjs';

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
