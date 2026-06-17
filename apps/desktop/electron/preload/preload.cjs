const { contextBridge, ipcRenderer } = require('electron');

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
  runHealthCheck: (toolCallId) => ipcRenderer.invoke('core:health', { toolCallId }),
  listShellTasks: () => ipcRenderer.invoke('shell:tasks:list'),
  stopActiveShellTask: () => ipcRenderer.invoke('shell:tasks:stop-active'),
  stopShellTask: (taskId) => ipcRenderer.invoke('shell:tasks:stop', { taskId }),
  listShellPermissionRules: () => ipcRenderer.invoke('shell:permissions:list'),
  addShellPermissionRule: (rule) => ipcRenderer.invoke('shell:permissions:add', rule),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  refreshSkills: () => ipcRenderer.invoke('skills:refresh'),
  uploadSkill: (zipBase64) => ipcRenderer.invoke('skills:upload', { zipBase64 }),
  enableSkill: (skillId) => ipcRenderer.invoke('skills:enable', { skillId }),
  disableSkill: (skillId) => ipcRenderer.invoke('skills:disable', { skillId }),
  workspaceList: () => ipcRenderer.invoke('workspace:list'),
  workspaceEnsureDefault: () => ipcRenderer.invoke('workspace:ensure-default'),
  workspaceAdd: () => ipcRenderer.invoke('workspace:add'),
  workspaceSetActive: (params) => ipcRenderer.invoke('workspace:set-active', params),
  workspaceRemove: (params) => ipcRenderer.invoke('workspace:remove', params),
  workspaceInfo: (params) => ipcRenderer.invoke('workspace:info', params),
  conversationsList: (params) => ipcRenderer.invoke('conversations:list', params),
  conversationsCreate: (params) => ipcRenderer.invoke('conversations:create', params),
  conversationsGet: (params) => ipcRenderer.invoke('conversations:get', params),
  conversationsUpdateTitle: (params) => ipcRenderer.invoke('conversations:update-title', params),
  conversationsAppendMessage: (params) => ipcRenderer.invoke('conversations:append-message', params),
  conversationsUpdateLastMessage: (params) => ipcRenderer.invoke('conversations:update-last-message', params),
  conversationsReplaceMessages: (params) => ipcRenderer.invoke('conversations:replace-messages', params),
  conversationsDelete: (params) => ipcRenderer.invoke('conversations:delete', params),
  conversationsAddUsage: (params) => ipcRenderer.invoke('conversations:add-usage', params),
  goalPlansList: (params) => ipcRenderer.invoke('goalPlans:list', params),
  goalPlansGet: (params) => ipcRenderer.invoke('goalPlans:get', params),
  goalPlansCreate: (params) => ipcRenderer.invoke('goalPlans:create', params),
  goalPlansRevise: (params) => ipcRenderer.invoke('goalPlans:revise', params),
  goalPlansApprove: (params) => ipcRenderer.invoke('goalPlans:approve', params),
  goalPlansSetStatus: (params) => ipcRenderer.invoke('goalPlans:set-status', params),
  goalPlansRecordTaskEvidence: (params) => ipcRenderer.invoke('goalPlans:record-task-evidence', params),
  goalPlansDelete: (params) => ipcRenderer.invoke('goalPlans:delete', params),
  chatSend: (params) => ipcRenderer.invoke('chat:send', params),
  chatAbort: (params) => ipcRenderer.invoke('chat:abort', params),
  chatStreamReattach: (params) => ipcRenderer.invoke('chat:stream:reattach', params),
  chatStreamListActive: () => ipcRenderer.invoke('chat:stream:list-active'),
  chatCompact: (params) => ipcRenderer.invoke('chat:compact', params),
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
  llmListProviders: () => ipcRenderer.invoke('llm:list'),
  llmAddProvider: (config) => ipcRenderer.invoke('llm:add', config),
  llmUpdateProvider: (params) => ipcRenderer.invoke('llm:update', params),
  llmRemoveProvider: (params) => ipcRenderer.invoke('llm:remove', params),
  llmSetDefault: (params) => ipcRenderer.invoke('llm:set-default', params),
  llmTestConnection: (params) => ipcRenderer.invoke('llm:test', params),
  llmOAuthStart: (params) => ipcRenderer.invoke('llm:oauth:start', params),
  llmOAuthCancel: () => ipcRenderer.invoke('llm:oauth:cancel'),
  llmListModels: (params) => ipcRenderer.invoke('llm:models:list', params),
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
  mcpReadResource: (params) => ipcRenderer.invoke('mcp:read-resource', params),
  mcpGetPrompt: (params) => ipcRenderer.invoke('mcp:get-prompt', params),
  mcpConnectAndRegister: (params) => ipcRenderer.invoke('mcp:connect-and-register', params),
});
