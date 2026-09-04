import path from 'node:path';

function canonicalPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(value.trim());
}

export function validateSkillInstallTarget(identity, registeredWorkspaces) {
  const request = identity && typeof identity === 'object' ? identity : {};
  const scope = request.scope === 'workspace' ? 'workspace' : 'global';
  if (scope === 'global') return { ...request, scope: 'global', workspacePath: undefined };

  const requestedPath = canonicalPath(request.workspacePath);
  if (!requestedPath) throw new Error('workspace_install_target_required');

  const registered = Array.isArray(registeredWorkspaces)
    ? registeredWorkspaces.find((workspace) => canonicalPath(workspace?.path) === requestedPath)
    : null;
  if (!registered) throw new Error('workspace_install_target_not_registered');

  return { ...request, scope: 'workspace', workspacePath: registered.path };
}
