function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function optionalFunction(value) {
  return typeof value === 'function' ? value : () => {};
}

function normalizePath(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeLinkedFolders(folders, primaryPath, basename) {
  const seen = new Set();
  const result = [];
  for (const folder of Array.isArray(folders) ? folders : []) {
    const folderPath = normalizePath(folder?.path);
    if (!folderPath || folderPath === primaryPath || seen.has(folderPath)) continue;
    seen.add(folderPath);
    result.push({
      path: folderPath,
      name: typeof folder?.name === 'string' && folder.name.trim()
        ? folder.name.trim()
        : basename(folderPath),
    });
  }
  return result;
}

function projectWorkspace(workspace, basename) {
  const path = normalizePath(workspace?.path);
  if (!path) return null;
  return {
    path,
    name: typeof workspace?.name === 'string' && workspace.name.trim()
      ? workspace.name.trim()
      : basename(path),
    addedAt: typeof workspace?.addedAt === 'string' ? workspace.addedAt : new Date(0).toISOString(),
    linkedFolders: normalizeLinkedFolders(workspace?.linkedFolders, path, basename),
  };
}

export function createWorkspaceApplicationService(options = {}) {
  const getSettings = assertFunction(options.getSettings, 'getSettings');
  const mergeSettings = assertFunction(options.mergeSettings, 'mergeSettings');
  const listConversations = assertFunction(options.listConversations, 'listConversations');
  const pathExists = assertFunction(options.pathExists, 'pathExists');
  const basename = assertFunction(options.basename, 'basename');
  const getDefaultWorkspacePath = assertFunction(
    options.getDefaultWorkspacePath,
    'getDefaultWorkspacePath',
  );
  const ensureDirectory = assertFunction(options.ensureDirectory, 'ensureDirectory');
  const chooseDirectory = assertFunction(options.chooseDirectory, 'chooseDirectory');
  const setChatWorkspacePath = assertFunction(
    options.setChatWorkspacePath,
    'setChatWorkspacePath',
  );
  const setSkillWorkspacePath = optionalFunction(options.setSkillWorkspacePath);
  const readProjectIndex = assertFunction(options.readProjectIndex, 'readProjectIndex');
  const nowIso = options.nowIso ?? (() => new Date().toISOString());

  function configuredWorkspaces() {
    return (getSettings().workspaces || [])
      .map((workspace) => projectWorkspace(workspace, basename))
      .filter(Boolean);
  }

  function findWorkspace(workspaces, workspacePath) {
    const target = normalizePath(workspacePath);
    return workspaces.find((workspace) => workspace.path === target) ?? null;
  }

  function listWorkspaces() {
    const all = getSettings();
    const configured = configuredWorkspaces();
    const knownPaths = new Set(configured.map((workspace) => workspace.path));
    const discovered = listConversations({ includeMessageCount: false })
      .map((conversation) => conversation.workspacePath)
      .filter((workspacePath) => typeof workspacePath === 'string' && pathExists(workspacePath))
      .filter((workspacePath) => {
        if (knownPaths.has(workspacePath)) return false;
        knownPaths.add(workspacePath);
        return true;
      })
      .map((workspacePath) => ({
        path: workspacePath,
        name: basename(workspacePath),
        addedAt: new Date(0).toISOString(),
        linkedFolders: [],
      }));

    return {
      workspaces: [...configured, ...discovered],
      activeWorkspace: all.activeWorkspace || null,
    };
  }

  function ensureDefaultWorkspace() {
    const all = getSettings();
    const workspaces = [...configuredWorkspaces()];
    if (all.activeWorkspace && pathExists(all.activeWorkspace)) {
      return {
        path: all.activeWorkspace,
        name: basename(all.activeWorkspace),
        created: false,
      };
    }

    const defaultDir = getDefaultWorkspacePath();
    let created = false;
    if (!pathExists(defaultDir)) {
      ensureDirectory(defaultDir);
      created = true;
    }
    const name = basename(defaultDir);
    if (!workspaces.some((workspace) => workspace.path === defaultDir)) {
      workspaces.push({ path: defaultDir, name, addedAt: nowIso(), linkedFolders: [] });
    }
    mergeSettings({ workspaces, activeWorkspace: defaultDir });
    setChatWorkspacePath(defaultDir);
    setSkillWorkspacePath(defaultDir);
    return { path: defaultDir, name, created };
  }

  async function addWorkspace(sender) {
    const dir = await chooseDirectory(sender);
    if (!dir) return null;

    const name = basename(dir);
    const workspaces = [...configuredWorkspaces()];
    if (workspaces.some((workspace) => workspace.path === dir)) {
      mergeSettings({ activeWorkspace: dir });
      setChatWorkspacePath(dir);
      setSkillWorkspacePath(dir);
      return { path: dir, name, existing: true };
    }

    workspaces.push({ path: dir, name, addedAt: nowIso(), linkedFolders: [] });
    mergeSettings({ workspaces, activeWorkspace: dir });
    setChatWorkspacePath(dir);
    setSkillWorkspacePath(dir);
    return { path: dir, name, existing: false };
  }

  function setActiveWorkspace(workspacePath) {
    const activeWorkspace = workspacePath || null;
    mergeSettings({ activeWorkspace });
    setChatWorkspacePath(activeWorkspace);
    setSkillWorkspacePath(activeWorkspace);
    return { activeWorkspace };
  }

  function removeWorkspace(workspacePath) {
    const all = getSettings();
    const workspaces = configuredWorkspaces().filter(
      (workspace) => workspace.path !== workspacePath,
    );
    const activeWorkspace = all.activeWorkspace === workspacePath
      ? null
      : all.activeWorkspace;
    mergeSettings({ workspaces, activeWorkspace });
    // Preserve the existing Desktop behavior: removal updates the Skill fallback only.
    setSkillWorkspacePath(activeWorkspace || null);
    return { workspaces, activeWorkspace };
  }

  function updateWorkspace({ path, name, linkedFolders } = {}) {
    const target = normalizePath(path);
    if (!target) return { ok: false, reason: 'missing-path' };
    const workspaces = configuredWorkspaces();
    const index = workspaces.findIndex((workspace) => workspace.path === target);
    if (index < 0) return { ok: false, reason: 'not-found', path: target };
    const current = workspaces[index];
    const nextName = typeof name === 'string' && name.trim() ? name.trim() : current.name;
    const nextLinked = linkedFolders === undefined
      ? current.linkedFolders
      : normalizeLinkedFolders(linkedFolders, current.path, basename);
    workspaces[index] = { ...current, name: nextName, linkedFolders: nextLinked };
    mergeSettings({ workspaces });
    return { ok: true, workspace: workspaces[index] };
  }

  async function addLinkedFolder(sender, { path } = {}) {
    const target = normalizePath(path);
    if (!target) return { ok: false, reason: 'missing-path' };
    const workspaces = configuredWorkspaces();
    const current = findWorkspace(workspaces, target);
    if (!current) return { ok: false, reason: 'not-found', path: target };
    const dir = await chooseDirectory(sender);
    if (!dir) return { ok: false, reason: 'cancelled' };
    if (dir === current.path) return { ok: false, reason: 'is-primary', path: dir };
    if (current.linkedFolders.some((folder) => folder.path === dir)) {
      return { ok: true, existing: true, workspace: current };
    }
    const otherPrimary = workspaces.find((workspace) => workspace.path === dir);
    if (otherPrimary) {
      return { ok: false, reason: 'other-project-primary', path: dir, name: otherPrimary.name };
    }
    current.linkedFolders = [
      ...current.linkedFolders,
      { path: dir, name: basename(dir) },
    ];
    mergeSettings({ workspaces });
    return { ok: true, existing: false, workspace: current };
  }

  function removeLinkedFolder({ path, folderPath } = {}) {
    const target = normalizePath(path);
    const linkedPath = normalizePath(folderPath);
    if (!target || !linkedPath) return { ok: false, reason: 'missing-path' };
    const workspaces = configuredWorkspaces();
    const current = findWorkspace(workspaces, target);
    if (!current) return { ok: false, reason: 'not-found', path: target };
    current.linkedFolders = current.linkedFolders.filter((folder) => folder.path !== linkedPath);
    mergeSettings({ workspaces });
    return { ok: true, workspace: current };
  }

  function setPrimaryFolder({ path, folderPath } = {}) {
    const target = normalizePath(path);
    const nextPrimary = normalizePath(folderPath);
    if (!target || !nextPrimary) return { ok: false, reason: 'missing-path' };
    const all = getSettings();
    const workspaces = configuredWorkspaces();
    const current = findWorkspace(workspaces, target);
    if (!current) return { ok: false, reason: 'not-found', path: target };
    if (nextPrimary === current.path) return { ok: true, workspace: current };
    const linked = current.linkedFolders.find((folder) => folder.path === nextPrimary);
    if (!linked) return { ok: false, reason: 'not-linked', path: nextPrimary };
    if (workspaces.some((workspace) => workspace.path === nextPrimary && workspace !== current)) {
      return { ok: false, reason: 'other-project-primary', path: nextPrimary };
    }
    current.linkedFolders = [
      { path: current.path, name: basename(current.path) },
      ...current.linkedFolders.filter((folder) => folder.path !== nextPrimary),
    ];
    current.path = nextPrimary;
    const activeWorkspace = all.activeWorkspace === target ? nextPrimary : all.activeWorkspace;
    mergeSettings({ workspaces, activeWorkspace });
    if (all.activeWorkspace === target) {
      setChatWorkspacePath(nextPrimary);
      setSkillWorkspacePath(nextPrimary);
    }
    return { ok: true, workspace: current };
  }

  function getWorkspaceInfo(workspacePath) {
    if (!workspacePath) return null;
    return readProjectIndex({ workspaceRoot: workspacePath })?.[0] || {
      name: basename(workspacePath),
      absolutePath: workspacePath,
    };
  }

  return Object.freeze({
    listWorkspaces,
    ensureDefaultWorkspace,
    addWorkspace,
    setActiveWorkspace,
    removeWorkspace,
    updateWorkspace,
    addLinkedFolder,
    removeLinkedFolder,
    setPrimaryFolder,
    getWorkspaceInfo,
  });
}
