function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function optionalFunction(value) {
  return typeof value === 'function' ? value : () => {};
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

  function listWorkspaces() {
    const all = getSettings();
    const configured = all.workspaces || [];
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
      }));

    return {
      workspaces: [...configured, ...discovered],
      activeWorkspace: all.activeWorkspace || null,
    };
  }

  function ensureDefaultWorkspace() {
    const all = getSettings();
    const workspaces = [...(all.workspaces || [])];
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
      workspaces.push({ path: defaultDir, name, addedAt: nowIso() });
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
    const all = getSettings();
    const workspaces = [...(all.workspaces || [])];
    if (workspaces.some((workspace) => workspace.path === dir)) {
      mergeSettings({ activeWorkspace: dir });
      setChatWorkspacePath(dir);
      setSkillWorkspacePath(dir);
      return { path: dir, name, existing: true };
    }

    workspaces.push({ path: dir, name, addedAt: nowIso() });
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
    const workspaces = (all.workspaces || []).filter(
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
    getWorkspaceInfo,
  });
}
