import path from 'node:path';
import { createShellArtifactStore } from './shell-artifacts.mjs';
import { createShellTaskManager } from './shell-task-manager.mjs';

// Application-owned process records. Workspace and conversation are provenance,
// never registry keys. Separate data homes remain isolated (including tests).
const managers = new Map();
export function getApplicationShellTasks(userDataPath) {
  if (!userDataPath) throw new TypeError('Application shell tasks require a data home');
  const key = path.resolve(userDataPath);
  if (!managers.has(key)) {
    managers.set(key, createShellTaskManager({
      artifactStore: createShellArtifactStore({ userDataPath: key }),
    }));
  }
  return managers.get(key);
}

export async function disposeApplicationShellTasks(userDataPath) {
  const key = path.resolve(userDataPath);
  const manager = managers.get(key);
  if (!manager) return;
  await manager.dispose();
  managers.delete(key);
}
