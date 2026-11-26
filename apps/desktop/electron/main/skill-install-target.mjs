import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createBotProfileStore, createProjectRegistry, isRemoteWorkspaceId } from '@peer-agent/runtime-node';

function workspacePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(value.trim());
}

function directoryInfo(folder) {
  if (!folder) return { path: null };
  let realPath = folder;
  try {
    realPath = realpathSync(folder);
    if (!statSync(realPath).isDirectory()) return { path: folder, unavailableReason: 'workspace_install_target_not_directory' };
    accessSync(realPath, constants.R_OK | (process.platform === 'win32' ? 0 : constants.X_OK));
    return { path: realPath };
  } catch (error) {
    return {
      path: realPath,
      unavailableReason: error.code === 'ENOENT' ? 'workspace_install_target_missing' : 'workspace_install_target_unreadable',
    };
  }
}

function pathKey(folder) {
  const normalized = workspacePath(folder);
  return process.platform === 'win32' ? normalized?.toLowerCase() : normalized;
}

export function createSkillInstallTargetDirectory({ dataHome, getSettings, getViewingBotId = () => null }) {
  const registry = createProjectRegistry({ filePath: path.join(dataHome, 'projects', 'registry.json') });
  const profiles = createBotProfileStore({ rootDir: dataHome });

  function snapshot() {
    const settings = getSettings();
    const currentBot = getViewingBotId();
    const active = pathKey(directoryInfo(workspacePath(settings.activeWorkspace)).path);
    const targets = new Map();
    const byPath = new Map();
    const registeredPaths = new Map();
    const pathsWithInactiveBot = new Set();
    const historicalPaths = new Set();

    function add({ id, name, kind, directory, aliases }) {
      const existing = targets.get(id) ?? byPath.get(pathKey(directory.path));
      if (aliases.some((alias) => pathsWithInactiveBot.has(alias)) && kind !== 'bot') return;
      // Only share a path alias when both rows resolve to the same directory.
      if (existing && pathKey(existing.path) !== pathKey(directory.path)) return;
      const target = existing ?? {
        id, workspaceId: id, name: name?.trim() || path.basename(directory.path) || directory.path,
        ...directory, available: !directory.unavailableReason, kind,
        isActive: currentBot ? id === currentBot : active === pathKey(directory.path),
      };
      targets.set(target.id, target);
      for (const alias of aliases) byPath.set(alias, target);
    }

    for (const entry of registry.diagnosticSnapshot()) {
      const folder = workspacePath(entry.path);
      if (!folder) continue;
      const directory = directoryInfo(folder);
      const aliases = [...new Set([pathKey(folder), pathKey(directory.path)])];
      for (const alias of aliases) registeredPaths.set(alias, entry.workspaceId);
      for (const oldPath of entry.previousPaths) historicalPaths.add(pathKey(oldPath));

      const profile = profiles.read(entry.workspaceId);
      if (profile?.status === 'active') {
        add({ id: entry.workspaceId, name: profile.displayName, kind: 'bot', directory, aliases });
        if (directory.unavailableReason) pathsWithInactiveBot.add(pathKey(entry.realPath));
      } else if (profile || existsSync(profiles.file(entry.workspaceId))) {
        for (const alias of [...aliases, pathKey(entry.realPath)]) pathsWithInactiveBot.add(alias);
      }
    }
    for (const workspace of Array.isArray(settings.workspaces) ? settings.workspaces : []) {
      const folder = workspacePath(workspace?.path);
      if (!folder) continue;
      const directory = directoryInfo(folder);
      const aliases = [...new Set([pathKey(folder), pathKey(directory.path)])];
      const registeredId = aliases.map((alias) => registeredPaths.get(alias)).find(Boolean);
      if (!registeredId && aliases.some((alias) => historicalPaths.has(alias))) continue;
      const classicId = typeof workspace.id === 'string' ? workspace.id.trim() : '';
      // A stale classic row cannot restore an inactive or unbound Bot's eligibility.
      if (classicId && classicId !== registeredId && isRemoteWorkspaceId(classicId) && existsSync(profiles.file(classicId))) continue;
      add({
        id: registeredId || classicId || `workspace:${pathKey(directory.path)}`,
        name: typeof workspace.name === 'string' ? workspace.name : '',
        kind: 'workspace', directory, aliases,
      });
    }
    return { targets, byPath };
  }

  function match({ targets, byPath }, request) {
    const id = typeof request?.workspaceId === 'string' ? request.workspaceId.trim() : '';
    const folder = workspacePath(request?.workspacePath);
    const byId = id ? targets.get(id) : null;
    const byFolder = folder ? byPath.get(pathKey(folder)) ?? byPath.get(pathKey(directoryInfo(folder).path)) : null;
    const target = byId ?? byFolder;
    const invalidPath = request?.workspacePath !== undefined && !folder;
    const invalidId = request?.workspaceId !== undefined && !id;
    const error = invalidPath || invalidId || (!id && !folder) ? 'workspace_install_target_required'
      : !target || (id && !byId) ? 'workspace_install_target_not_registered'
      : folder && target !== byFolder ? 'workspace_install_target_mismatch'
      : target.unavailableReason;
    const receipt = target ? { workspaceId: target.workspaceId, name: target.name, path: target.path }
      : { workspaceId: id || null, name: folder ? path.basename(folder) || folder : id, path: folder };
    return { receipt, error };
  }

  return {
    list: () => [...snapshot().targets.values()],
    resolve(requests) {
      const current = snapshot();
      const seen = new Set();
      return requests.map((request) => match(current, request)).filter(({ receipt, error }) => {
        const key = JSON.stringify([receipt.workspaceId, receipt.path, error]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    recheck(target) {
      const { error, receipt } = match(snapshot(), { workspaceId: target.workspaceId });
      if (error) throw new Error(error);
      if (pathKey(receipt.path) !== pathKey(target.path)) throw new Error('workspace_install_target_changed');
      return receipt.path;
    },
  };
}

function failure(receipt, error) {
  return {
    ...receipt, ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
  };
}

/** Prepare the package once, then record independent writes for the selected targets. */
export async function installMarketplacePackage(identity, directory, prepare, installError) {
  const scope = identity?.scope === 'workspace' ? 'workspace' : 'global';
  const batch = identity?.targets !== undefined;
  if (batch && (scope !== 'workspace' || !Array.isArray(identity.targets) || !identity.targets.length)) {
    throw new Error('workspace_install_target_required');
  }
  const destinations = scope === 'workspace' ? directory.resolve(batch ? identity.targets : [identity]) : [];
  const write = async (install, workspacePath) => {
    const result = await install({ scope, workspacePath });
    const skillId = result?.skillId ?? result?.id;
    if (!skillId) throw new Error(installError);
    return skillId;
  };
  if (!batch) {
    const destination = destinations[0];
    if (destination?.error) throw new Error(destination.error);
    const { install, metadata } = await prepare();
    const workspacePath = destination ? directory.recheck(destination.receipt) : null;
    const installedSkillId = await write(install, workspacePath);
    return { ...metadata, ok: true, installedSkillId, scope };
  }

  let prepared;
  let packageError;
  if (destinations.some((target) => !target.error)) {
    try { prepared = await prepare(); }
    catch (error) { packageError = error; }
  }

  const results = [];
  let installedSkillId;
  for (const { receipt, error } of destinations) {
    try {
      if (error) throw new Error(error);
      if (!prepared) throw packageError;
      const skillId = await write(prepared.install, directory.recheck(receipt));
      installedSkillId ??= skillId;
      results.push({ ...receipt, ok: true, skillId });
    } catch (error) {
      results.push(failure(receipt, error));
    }
  }
  const succeededCount = results.filter((result) => result.ok).length;
  const failedCount = results.length - succeededCount;
  return {
    ...prepared?.metadata,
    ok: failedCount === 0, partial: succeededCount > 0 && failedCount > 0,
    succeededCount, failedCount, results, installedSkillId, scope,
  };
}
