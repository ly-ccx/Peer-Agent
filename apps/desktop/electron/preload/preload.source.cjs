const { contextBridge, ipcRenderer: electronIpcRenderer } = require('electron');

const channelOverrides = new Map(/* __PEER_IPC_CHANNELS__ */ []);
const resolveChannel = (key) => channelOverrides.get(key) ?? key;
const listenerChannels = new WeakMap();
const ipcRenderer = Object.freeze({
  invoke: (key, ...args) => electronIpcRenderer.invoke(resolveChannel(key), ...args),
  send: (key, ...args) => electronIpcRenderer.send(resolveChannel(key), ...args),
  sendSync: (key, ...args) => electronIpcRenderer.sendSync(resolveChannel(key), ...args),
  on: (key, listener) => {
    listenerChannels.set(listener, resolveChannel(key));
    electronIpcRenderer.on(resolveChannel(key), listener);
  },
  removeListener: (key, listener) => {
    electronIpcRenderer.removeListener(listenerChannels.get(listener) ?? resolveChannel(key), listener);
    listenerChannels.delete(listener);
  },
});

function readInitialSettings() {
  try {
    const result = ipcRenderer.sendSync('settings:get-sync');
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch {
    /* main 未就绪/异常 → 空对象，renderer 落默认 */
  }
  return {};
}

contextBridge.exposeInMainWorld('peerAgent', {
  initialSettings: readInitialSettings(),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  onAppearanceChanged: (listener) => {
    const handler = (_event, appearance) => listener(appearance);
    ipcRenderer.on('appearance:changed', handler);
    return () => ipcRenderer.removeListener('appearance:changed', handler);
  },
  getShortcutStatus: () => ipcRenderer.invoke('shortcuts:status'),
  updateShortcut: (action, accelerator) => ipcRenderer.invoke('shortcuts:update', action, accelerator),
  resetShortcut: (action) => ipcRenderer.invoke('shortcuts:reset', action),
  // Appshots（P0a：用户手势捕获前台窗口，ADR 59）
  appshotCapture: () => ipcRenderer.invoke('appshot:capture'),
  appshotPermissionStatus: () => ipcRenderer.invoke('appshot:permission-status'),
  appshotOpenScreenSettings: () => ipcRenderer.invoke('appshot:open-screen-settings'),
  getDeveloperSettings: () => ipcRenderer.invoke('developer-settings:get'),
  updateDeveloperSettings: (partial) => ipcRenderer.invoke('developer-settings:update', partial),
  resetDeveloperSettings: () => ipcRenderer.invoke('developer-settings:reset'),
  getDeveloperDiagnostics: () => ipcRenderer.invoke('developer-settings:diagnostics'),
  exportConfig: () => ipcRenderer.invoke('settings:export'),
  importConfig: () => ipcRenderer.invoke('settings:import'),
  getBootstrap: () => ipcRenderer.invoke('bootstrap:get'),
  getClientSession: () => ipcRenderer.invoke('session:get'),
  listCapabilities: () => ipcRenderer.invoke('capabilities:list'),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getRuntimeProjection: () => ipcRenderer.invoke('runtime-projection:get'),
  setLocale: (locale) => ipcRenderer.invoke('locale:set', { locale }),
  approveLocalAction: (toolCallId, options) => ipcRenderer.invoke('permission:approve', { toolCallId, ...(options || {}) }),
  denyLocalAction: (toolCallId) => ipcRenderer.invoke('permission:deny', { toolCallId }),
  executeClientToolCall: (call, grant) => ipcRenderer.invoke('client-tool:execute', { call, grant }),
  openPath: (absPath, workspaceRoot) => ipcRenderer.invoke('shell:open-path', { absPath, workspaceRoot }),
  gitDiff: (absPath, workspaceRoot, relPath) => ipcRenderer.invoke('git:diff', { absPath, workspaceRoot, relPath }),
  fileExists: (absPath, workspaceRoot, relPath) => ipcRenderer.invoke('fs:exists', { absPath, workspaceRoot, relPath }),
  readFile: (absPath, workspaceRoot, relPath) => ipcRenderer.invoke('file:read', { absPath, workspaceRoot, relPath }),
  readImageDataUrl: (absPath, workspaceRoot, relPath) =>
    ipcRenderer.invoke('file:read-image-data-url', { absPath, workspaceRoot, relPath }),
  writeFile: (absPath, workspaceRoot, relPath, content) => ipcRenderer.invoke('file:write', { absPath, workspaceRoot, relPath, content }),
  mkdir: (absPath, workspaceRoot, relPath) => ipcRenderer.invoke('fs:mkdir', { absPath, workspaceRoot, relPath }),
  readDir: (absPath, workspaceRoot, relPath) => ipcRenderer.invoke('fs:read-dir', { absPath, workspaceRoot, relPath }),
  /** 同步 Workbench 文件树要监听的目录集合（根 + 已展开）；传空数组清空。 */
  watchDirs: (paths, workspaceRoot) => ipcRenderer.invoke('fs:watch-dirs', { paths, workspaceRoot }),
  /** 订阅目录变更；返回 unsubscribe。payload: { dirPath } */
  onFsDirChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('fs:dir-changed', handler);
    return () => ipcRenderer.removeListener('fs:dir-changed', handler);
  },
  // 会话级内嵌浏览器标签控制句柄注册（见 ADR 40 / 46）。
  registerBrowserWebContents: (registration) =>
    ipcRenderer.invoke('browser:register-webcontents', registration),
  onBrowserPanelRevealRequest: (listener) => {
    const handler = (_event, request) => listener(request);
    ipcRenderer.on('browser:panel-reveal-request', handler);
    return () => ipcRenderer.removeListener('browser:panel-reveal-request', handler);
  },
  acknowledgeBrowserPanelReveal: (payload) =>
    ipcRenderer.invoke('browser:panel-reveal-ack', payload),
  unregisterBrowserWebContents: (registration) =>
    ipcRenderer.invoke('browser:unregister-webcontents', registration),
  /** 清除当前 origin 的站点 Cookie/存储（peer-browser 分区）；不触碰密码库。 */
  clearBrowserSiteData: (url) => ipcRenderer.invoke('browser:clear-site-data', { url }),
  /** 截取指定 webContents 页面并保存 PNG；savePath 可选。 */
  captureBrowserPage: (webContentsId, savePath) =>
    ipcRenderer.invoke('browser:capture-page', { webContentsId, savePath }),
  /** 列出可导入会话的浏览器 Profile（无 Cookie value）。 */
  listBrowserSessionSources: () => ipcRenderer.invoke('browser:list-session-sources'),
  /** Agent 启动必需的 macOS 系统权限自检（不绑 Chrome 导入）。 */
  getStartupOsPermissions: () => ipcRenderer.invoke('os:startup-permissions'),
  /** 导入前权限/环境自检。 */
  getBrowserSessionImportPreflight: () => ipcRenderer.invoke('browser:session-import-preflight'),
  /** 打开 macOS 完全磁盘访问权限设置。 */
  openFullDiskAccessSettings: (payload) => ipcRenderer.invoke('browser:open-full-disk-access-settings', payload || {}),
  /** 获取可拖到“完全磁盘访问”列表的 App 路径与图标。 */
  getAppDragTarget: () => ipcRenderer.invoke('browser:get-app-drag-target'),
  /**
   * 开始把 App 拖到系统设置（完全磁盘访问列表）。
   * 必须在 renderer 的 dragstart 事件中同步调用。
   */
  startAppDrag: (payload) => ipcRenderer.sendSync('browser:start-app-drag', payload || {}),
  /** 关闭 FDA 拖拽浮窗（设置下方的 always-on-top LOGO 条）。 */
  hideFdaDragFloat: () => ipcRenderer.sendSync('browser:hide-fda-drag-float-sync'),
  setFdaDragFloatDragging: (dragging) => ipcRenderer.send('browser:fda-drag-float-dragging', { dragging: Boolean(dragging) }),
  /** 扫描 Profile 站点聚合（无 Cookie value）。 */
  listBrowserSessionSites: (profileId) =>
    ipcRenderer.invoke('browser:list-session-sites', { profileId }),
  /**
   * 导入选定站点 Cookie 到 persist:peer-browser。
   * 仅 Cookie，不导入密码。
   */
  importBrowserSiteSession: (payload) =>
    ipcRenderer.invoke('browser:import-site-session', payload),
  /** Password manager Phase 1：列表仅 meta，无 password 明文。 */
  listPasswordVaultEntries: (origin) =>
    ipcRenderer.invoke('password-vault:list', { origin }),
  upsertPasswordVaultEntry: (payload) =>
    ipcRenderer.invoke('password-vault:upsert', payload),
  deletePasswordVaultEntry: (id) =>
    ipcRenderer.invoke('password-vault:delete', { id }),
  revealPasswordVaultEntry: (id) =>
    ipcRenderer.invoke('password-vault:reveal', { id }),
  fillPasswordVaultEntry: (payload) =>
    ipcRenderer.invoke('password-vault:fill', payload),
  listShellTasks: () => ipcRenderer.invoke('shell:tasks:list'),
  stopActiveShellTask: () => ipcRenderer.invoke('shell:tasks:stop-active'),
  stopShellTask: (taskId) => ipcRenderer.invoke('shell:tasks:stop', { taskId }),
  listShellPermissionRules: () => ipcRenderer.invoke('shell:permissions:list'),
  addShellPermissionRule: (rule) => ipcRenderer.invoke('shell:permissions:add', rule),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  getSkillDetail: (skillId) => ipcRenderer.invoke('skills:get-detail', { skillId }),
  refreshSkills: () => ipcRenderer.invoke('skills:refresh'),
  uploadSkill: (zipBase64) => ipcRenderer.invoke('skills:upload', { zipBase64 }),
  enableSkill: (skillId) => ipcRenderer.invoke('skills:enable', { skillId }),
  disableSkill: (skillId) => ipcRenderer.invoke('skills:disable', { skillId }),
  listAvailableSkills: () => ipcRenderer.invoke('skills:list-available'),
  linkSkill: (skillId) => ipcRenderer.invoke('skills:link', { skillId }),
  unlinkSkill: (skillId) => ipcRenderer.invoke('skills:unlink', { skillId }),
  uninstallSkill: (skillId) => ipcRenderer.invoke('skills:uninstall', { skillId }),
  listMarketplaceSkills: () => ipcRenderer.invoke('skills:marketplace:list'),
  getMarketplaceSkillDetail: (catalogId) => ipcRenderer.invoke('skills:marketplace:get-detail', { catalogId }),
  installMarketplaceSkill: (catalogId) => ipcRenderer.invoke('skills:marketplace:install', { catalogId }),
  querySkillHubSkills: (query) => ipcRenderer.invoke('skills:skillhub:query', query || {}),
  getSkillHubSkillDetail: (identity) => ipcRenderer.invoke('skills:skillhub:get-detail', identity || {}),
  getSkillHubSyncStatus: () => ipcRenderer.invoke('skills:skillhub:get-status'),
  syncSkillHubSkills: (options) => ipcRenderer.invoke('skills:skillhub:sync', options || {}),
  installSkillHubSkill: (identity) => ipcRenderer.invoke('skills:skillhub:install', identity || {}),
  listSkillHubCategories: () => ipcRenderer.invoke('skills:skillhub:list-categories'),
  workspaceList: () => ipcRenderer.invoke('workspace:list'),
  quickChatHide: () => ipcRenderer.invoke('quick-chat:hide'),
  quickChatSetTaskCardVisible: (visible) => ipcRenderer.invoke('quick-chat:set-task-card-visible', { visible }),
  quickChatSetContentHeight: (height) => ipcRenderer.invoke('quick-chat:set-content-height', { height }),
  quickChatShowPopover: (payload) => ipcRenderer.invoke('quick-chat-popover:show', payload),
  quickChatHidePopover: () => ipcRenderer.invoke('quick-chat-popover:hide'),
  quickChatSelectPopoverValue: (value) => ipcRenderer.invoke('quick-chat-popover:select', value),
  quickChatSubmit: (params) => ipcRenderer.invoke('quick-chat:submit', params),
  onQuickChatShown: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('quick-chat:shown', handler);
    return () => ipcRenderer.removeListener('quick-chat:shown', handler);
  },
  onQuickChatPopoverState: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('quick-chat-popover:state', handler);
    return () => ipcRenderer.removeListener('quick-chat-popover:state', handler);
  },
  onQuickChatPopoverSelected: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('quick-chat:popover-selected', handler);
    return () => ipcRenderer.removeListener('quick-chat:popover-selected', handler);
  },
  onQuickChatPopoverClosed: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('quick-chat:popover-closed', handler);
    return () => ipcRenderer.removeListener('quick-chat:popover-closed', handler);
  },
  workspaceEnsureDefault: () => ipcRenderer.invoke('workspace:ensure-default'),
  workspaceAdd: () => ipcRenderer.invoke('workspace:add'),
  workspaceSetActive: (params) => ipcRenderer.invoke('workspace:set-active', params),
  workspaceRemove: (params) => ipcRenderer.invoke('workspace:remove', params),
  workspaceInfo: (params) => ipcRenderer.invoke('workspace:info', params),
  conversationsList: (params) => ipcRenderer.invoke('conversations:list', params),
  usageGetStats: () => ipcRenderer.invoke('usage:stats'),
  usageGetDaily: (params) => ipcRenderer.invoke('usage:daily', params),
  usageGetDay: (params) => ipcRenderer.invoke('usage:day', params),
  conversationsSearch: (params) => ipcRenderer.invoke('conversations:search', params),
  conversationsCreate: (params) => ipcRenderer.invoke('conversations:create', params),
  conversationsGet: (params) => ipcRenderer.invoke('conversations:get', params),
  onConversationsChanged: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('conversations:changed', handler);
    return () => ipcRenderer.removeListener('conversations:changed', handler);
  },
  onWorkspacesChanged: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('workspaces:changed', handler);
    return () => ipcRenderer.removeListener('workspaces:changed', handler);
  },
  conversationsUpdateTitle: (params) => ipcRenderer.invoke('conversations:update-title', params),
  conversationsUpdateMode: (params) => ipcRenderer.invoke('conversations:update-mode', params),
  conversationsUpdateModelEffort: (params) => ipcRenderer.invoke('conversations:update-model-effort', params),
  conversationsAppendMessage: (params) => ipcRenderer.invoke('conversations:append-message', params),
  conversationsUpdateLastMessage: (params) => ipcRenderer.invoke('conversations:update-last-message', params),
  conversationsReplaceMessages: (params) => ipcRenderer.invoke('conversations:replace-messages', params),
  conversationsArchive: (params) => ipcRenderer.invoke('conversations:archive', params),
  conversationsRestore: (params) => ipcRenderer.invoke('conversations:restore', params),
  conversationsPin: (params) => ipcRenderer.invoke('conversations:pin', params),
  conversationsUnpin: (params) => ipcRenderer.invoke('conversations:unpin', params),
  conversationsReorderPinned: (params) => ipcRenderer.invoke('conversations:reorder-pinned', params),
  conversationsAutoArchive: (params) => ipcRenderer.invoke('conversations:auto-archive', params),
  conversationsDelete: (params) => ipcRenderer.invoke('conversations:delete', params),
  conversationsAddUsage: (params) => ipcRenderer.invoke('conversations:add-usage', params),
  automationsBootstrap: () => ipcRenderer.invoke('automations:bootstrap'),
  automationsList: (params) => ipcRenderer.invoke('automations:list', params),
  automationsGet: (params) => ipcRenderer.invoke('automations:get', params),
  automationsCreate: (params) => ipcRenderer.invoke('automations:create', params),
  automationsUpdate: (params) => ipcRenderer.invoke('automations:update', params),
  automationRunsList: (params) => ipcRenderer.invoke('automations:runs:list', params),
  automationRunsGet: (params) => ipcRenderer.invoke('automations:runs:get', params),
  automationsRunNow: (params) => ipcRenderer.invoke('automations:run-now', params),
  automationRunsRetry: (params) => ipcRenderer.invoke('automations:runs:retry', params),
  automationRunsCancel: (params) => ipcRenderer.invoke('automations:runs:cancel', params),
  automationsSetRuntimePaused: (params) => ipcRenderer.invoke('automations:runtime:set-paused', params),
  automationProposalAct: (params) => ipcRenderer.invoke('automations:proposal:act', params),
  onAutomationsChanged: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('automations:changed', handler);
    return () => ipcRenderer.removeListener('automations:changed', handler);
  },
  onAutomationOpenRun: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('automations:open-run', handler);
    return () => ipcRenderer.removeListener('automations:open-run', handler);
  },
  goalPlansList: (params) => ipcRenderer.invoke('goalPlans:list', params),
  goalPlansAwaitingCounts: () => ipcRenderer.invoke('goalPlans:awaiting-counts'),
  goalPlansGet: (params) => ipcRenderer.invoke('goalPlans:get', params),
  goalPlansCreate: (params) => ipcRenderer.invoke('goalPlans:create', params),
  goalPlansRevise: (params) => ipcRenderer.invoke('goalPlans:revise', params),
  goalPlansApprove: (params) => ipcRenderer.invoke('goalPlans:approve', params),
  goalPlansSetStatus: (params) => ipcRenderer.invoke('goalPlans:set-status', params),
  goalPlansRecordManualConfirmation: (params) => ipcRenderer.invoke('goalPlans:record-manual-confirmation', params),
  goalPlansRecordTaskEvidence: (params) => ipcRenderer.invoke('goalPlans:record-task-evidence', params),
  goalPlansDelete: (params) => ipcRenderer.invoke('goalPlans:delete', params),
  goalRunnerGetState: (params) => ipcRenderer.invoke('goalRunner:get-state', params),
  goalRunnerStart: (params) => ipcRenderer.invoke('goalRunner:start', params),
  goalRunnerPause: (params) => ipcRenderer.invoke('goalRunner:pause', params),
  goalRunnerResume: (params) => ipcRenderer.invoke('goalRunner:resume', params),
  goalRunnerClear: (params) => ipcRenderer.invoke('goalRunner:clear', params),
  onGoalPlansChanged: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('goalPlans:changed', handler);
    return () => ipcRenderer.removeListener('goalPlans:changed', handler);
  },
  onGoalRunnerChanged: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('goalRunner:changed', handler);
    return () => ipcRenderer.removeListener('goalRunner:changed', handler);
  },
  chatSend: (params) => ipcRenderer.invoke('chat:send', params),
  chatAbort: (params) => ipcRenderer.invoke('chat:abort', params),
  chatStreamReattach: (params) => ipcRenderer.invoke('chat:stream:reattach', params),
  chatStreamListActive: () => ipcRenderer.invoke('chat:stream:list-active'),
  chatCompact: (params) => ipcRenderer.invoke('chat:compact', params),
  chatCompactionGet: (params) => ipcRenderer.invoke('chat:compaction:get', params),
  // restored 重投影:快照缺失/跨宿主时由 Runtime 按完整成分重算占用。
  chatContextRestored: (params) => ipcRenderer.invoke('chat:context:restored', params),
  promptSnapshotsList: (params) => ipcRenderer.invoke('prompt-snapshots:list', params),
  promptSnapshotsGet: (params) => ipcRenderer.invoke('prompt-snapshots:get', params),
  promptContextEpochsList: (params) => ipcRenderer.invoke('prompt-context-epochs:list', params),
  promptContextEpochEvents: (params) => ipcRenderer.invoke('prompt-context-epochs:events', params),
  promptContextEpochChain: (params) => ipcRenderer.invoke('prompt-context-epochs:chain', params),
  onChatStreamDelta: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:delta', handler);
    return () => ipcRenderer.removeListener('chat:stream:delta', handler);
  },
  onChatStreamThinking: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:thinking', handler);
    return () => ipcRenderer.removeListener('chat:stream:thinking', handler);
  },
  onChatStreamDone: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:done', handler);
    return () => ipcRenderer.removeListener('chat:stream:done', handler);
  },
  onChatStreamAborted: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:aborted', handler);
    return () => ipcRenderer.removeListener('chat:stream:aborted', handler);
  },
  onChatStreamUsage: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:usage', handler);
    return () => ipcRenderer.removeListener('chat:stream:usage', handler);
  },
  onChatStreamToolCall: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:tool-call', handler);
    return () => ipcRenderer.removeListener('chat:stream:tool-call', handler);
  },
  onChatStreamToolProgress: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:tool-progress', handler);
    return () => ipcRenderer.removeListener('chat:stream:tool-progress', handler);
  },
  onChatStreamToolResult: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:tool-result', handler);
    return () => ipcRenderer.removeListener('chat:stream:tool-result', handler);
  },
  onChatStreamPermissionRequest: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:permission-request', handler);
    return () => ipcRenderer.removeListener('chat:stream:permission-request', handler);
  },
  onChatStreamError: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:error', handler);
    return () => ipcRenderer.removeListener('chat:stream:error', handler);
  },
  onChatStreamProviderRecovery: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:provider-recovery', handler);
    return () => ipcRenderer.removeListener('chat:stream:provider-recovery', handler);
  },
  onChatStreamConnectionRecovery: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:connection-recovery', handler);
    return () => ipcRenderer.removeListener('chat:stream:connection-recovery', handler);
  },
  onChatCompaction: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:compaction', handler);
    return () => ipcRenderer.removeListener('chat:compaction', handler);
  },
  onChatActiveStreamsChanged: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:active-changed', handler);
    return () => ipcRenderer.removeListener('chat:stream:active-changed', handler);
  },
  onWindowFullscreenChanged: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('window:fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('window:fullscreen-changed', handler);
  },
  llmListProviderGroups: () => ipcRenderer.invoke('llm:groups:list'),
  llmListProviders: () => ipcRenderer.invoke('llm:list'),
  llmListChatProviders: () => ipcRenderer.invoke('llm:chat:list'),
  llmListChannels: () => ipcRenderer.invoke('llm:channels:list'),
  llmListServiceTemplates: () => ipcRenderer.invoke('llm:service-templates:list'),
  llmAddProvider: (config) => ipcRenderer.invoke('llm:add', config),
  llmUpdateProvider: (params) => ipcRenderer.invoke('llm:update', params),
  llmDuplicateProvider: (params) => ipcRenderer.invoke('llm:duplicate', params),
  llmDuplicateModel: (params) => ipcRenderer.invoke('llm:duplicate-model', params),
  llmAddModel: (params) => ipcRenderer.invoke('llm:add-model', params),
  llmRemoveProvider: (params) => ipcRenderer.invoke('llm:remove', params),
  llmRemoveGroup: (params) => ipcRenderer.invoke('llm:remove-group', params),
  llmSetDefault: (params) => ipcRenderer.invoke('llm:set-default', params),
  llmTestConnection: (params) => ipcRenderer.invoke('llm:test', params),
  llmComplete: (params) => ipcRenderer.invoke('llm:complete', params),
  llmGetSubscriptionQuota: (params) => ipcRenderer.invoke('llm:quota', params),
  llmOAuthStart: (params) => ipcRenderer.invoke('llm:oauth:start', params),
  llmOAuthOpenPending: () => ipcRenderer.invoke('llm:oauth:open-pending'),
  llmOAuthCancel: () => ipcRenderer.invoke('llm:oauth:cancel'),
  onLlmOAuthPending: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('llm:oauth:pending', handler);
    return () => ipcRenderer.removeListener('llm:oauth:pending', handler);
  },
  onLlmOAuthAuthorized: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('llm:oauth:authorized', handler);
    return () => ipcRenderer.removeListener('llm:oauth:authorized', handler);
  },
  onLlmOAuthRefreshed: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('llm:oauth:refreshed', handler);
    return () => ipcRenderer.removeListener('llm:oauth:refreshed', handler);
  },
  llmListModels: (params) => ipcRenderer.invoke('llm:models:list', params),
  llmFetchModels: (params) => ipcRenderer.invoke('llm:models:fetch', params),
  restartHost: (options) => ipcRenderer.invoke('host:restart', options || {}),
  writePendingTask: (task) => ipcRenderer.invoke('pending-task:write', task || {}),
  consumePendingTask: () => ipcRenderer.invoke('pending-task:consume'),
  peekPendingTask: () => ipcRenderer.invoke('pending-task:peek'),
  clearPendingTask: () => ipcRenderer.invoke('pending-task:clear'),
  mcpListInstalled: () => ipcRenderer.invoke('mcp:list-installed'),
  mcpListCapabilities: () => ipcRenderer.invoke('mcp:list-capabilities'),
  mcpListCredentials: () => ipcRenderer.invoke('mcp:list-credentials'),
  mcpPutCredential: (item) => ipcRenderer.invoke('mcp:put-credential', item),
  mcpDeleteCredential: (params) => ipcRenderer.invoke('mcp:delete-credential', params),
  mcpInstall: (item) => ipcRenderer.invoke('mcp:install', item),
  mcpUpsertServer: (item) => ipcRenderer.invoke('mcp:upsert-server', item),
  mcpUninstall: (params) => ipcRenderer.invoke('mcp:uninstall', params),
  mcpSetEnabled: (params) => ipcRenderer.invoke('mcp:set-enabled', params),
  mcpSetToolVisibility: (params) => ipcRenderer.invoke('mcp:set-tool-visibility', params),
  mcpTestConnection: (params) => ipcRenderer.invoke('mcp:test-connection', params),
  mcpRefreshManifest: (params) => ipcRenderer.invoke('mcp:refresh-manifest', params),
  mcpStartOAuth: (params) => ipcRenderer.invoke('mcp:start-oauth', params),
  mcpFinishOAuth: (params) => ipcRenderer.invoke('mcp:finish-oauth', params),
  mcpReadResource: (params) => ipcRenderer.invoke('mcp:read-resource', params),
  mcpGetPrompt: (params) => ipcRenderer.invoke('mcp:get-prompt', params),
  mcpConnectAndRegister: (params) => ipcRenderer.invoke('mcp:connect-and-register', params),
  // ── Updater ──
  updaterGetStatus: () => ipcRenderer.invoke('updater:get-status'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  updaterOpenInstaller: () => ipcRenderer.invoke('updater:open-installer'),
  updaterOpenReleasePage: () => ipcRenderer.invoke('updater:open-release-page'),
  updaterSetChannel: (preference) => ipcRenderer.invoke('updater:set-channel', preference),
  onUpdaterEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('updater:event', handler);
    return () => ipcRenderer.removeListener('updater:event', handler);
  },
  onQuickChatConversationCreated: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('quick-chat:conversation-created', handler);
    return () => ipcRenderer.removeListener('quick-chat:conversation-created', handler);
  },
  onQuickChatOpenConversation: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('quick-chat:open-conversation', handler);
    return () => ipcRenderer.removeListener('quick-chat:open-conversation', handler);
  },
  onTrayNewChat: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('tray:new-chat', handler);
    return () => ipcRenderer.removeListener('tray:new-chat', handler);
  },
  onTrayMore: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('tray:more', handler);
    return () => ipcRenderer.removeListener('tray:more', handler);
  },
  // 上报主窗口当前前台会话，供任务系统通知做同会话抑制 / 已读。
  setActiveConversation: (payload) => ipcRenderer.invoke('conversation:set-active', payload || {}),
  onRuntimeEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('runtime:event', handler);
    return () => ipcRenderer.removeListener('runtime:event', handler);
  },
});
