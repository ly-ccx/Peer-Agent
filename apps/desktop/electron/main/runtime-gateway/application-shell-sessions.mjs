import path from 'node:path';
import { createNodeShellSessionManager, supportsPersistentShellSession } from '@peer-agent/runtime-node';
import { buildShellSessionBootstrap } from './shell-env-snapshot.mjs';

// The application owns cleanup, while each workspace/conversation keeps its own
// shell environment. No background process ownership is stored in this module.
const homes = new Map();
export function getApplicationShellSessions(home, workspaceRoot) {
  if (!supportsPersistentShellSession() || !workspaceRoot) return null;
  const key = path.resolve(home);
  if (!homes.has(key)) homes.set(key, new Map());
  const workspaces = homes.get(key);
  const root = path.resolve(workspaceRoot);
  if (workspaces.has(root)) return workspaces.get(root);
  const manager = createNodeShellSessionManager({ workspaceRoot: root, bootstrapScript: buildShellSessionBootstrap() });
  const active = new Map();
  const sessions = {
    async runCommand(options) {
      const conversationId = options.conversationId ?? null;
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
      if (!active.has(conversationId)) active.set(conversationId, new Set());
      const controllers = active.get(conversationId);
      controllers.add(controller);
      try { return await manager.runCommand({ ...options, signal: controller.signal }); }
      finally {
        controllers.delete(controller);
        if (!controllers.size) active.delete(conversationId);
        options.signal?.removeEventListener('abort', abort);
      }
    },
    stopActiveCommand(conversationId) {
      const controllers = active.get(conversationId ?? null);
      if (!controllers?.size) return { stopped: false, reason: 'no_running_shell_task' };
      for (const controller of controllers) controller.abort();
      return { stopped: true };
    },
    async disposeConversation(conversationId) {
      sessions.stopActiveCommand(conversationId);
      await manager.disposeConversation(conversationId);
    },
    async disposeAll() {
      for (const id of active.keys()) sessions.stopActiveCommand(id);
      await manager.disposeAll();
    },
  };
  workspaces.set(root, sessions);
  return sessions;
}

export async function disposeApplicationShellConversation(home, conversationId) {
  const workspaces = homes.get(path.resolve(home));
  if (workspaces) await Promise.all([...workspaces.values()].map((manager) => manager.disposeConversation(conversationId)));
}

export async function disposeApplicationShellSessions(home) {
  const key = path.resolve(home);
  const workspaces = homes.get(key);
  if (workspaces) await Promise.all([...workspaces.values()].map((manager) => manager.disposeAll()));
  homes.delete(key);
}
