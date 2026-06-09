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
  exportConfig: () => ipcRenderer.invoke('settings:export'),
  importConfig: () => ipcRenderer.invoke('settings:import'),
  getBootstrap: () => ipcRenderer.invoke('bootstrap:get'),
  getClientSession: () => ipcRenderer.invoke('session:get'),
  listCapabilities: () => ipcRenderer.invoke('capabilities:list'),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getRuntimeProjection: () => ipcRenderer.invoke('runtime-projection:get'),
  setLocale: (locale) => ipcRenderer.invoke('locale:set', { locale }),
  approveLocalAction: (toolCallId) => ipcRenderer.invoke('permission:approve', { toolCallId }),
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
  chatSend: (params) => ipcRenderer.invoke('chat:send', params),
  chatAbort: (params) => ipcRenderer.invoke('chat:abort', params),
  chatCompact: (params) => ipcRenderer.invoke('chat:compact', params),
  onChatStreamDelta: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:stream:delta', handler);
    return () => ipcRenderer.removeListener('chat:stream:delta', handler);
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
  onChatCompaction: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('chat:compaction', handler);
    return () => ipcRenderer.removeListener('chat:compaction', handler);
  },
  llmListProviders: () => ipcRenderer.invoke('llm:list'),
  llmAddProvider: (config) => ipcRenderer.invoke('llm:add', config),
  llmUpdateProvider: (params) => ipcRenderer.invoke('llm:update', params),
  llmRemoveProvider: (params) => ipcRenderer.invoke('llm:remove', params),
  llmSetDefault: (params) => ipcRenderer.invoke('llm:set-default', params),
  llmTestConnection: (params) => ipcRenderer.invoke('llm:test', params),
  mcpListInstalled: () => ipcRenderer.invoke('mcp:list-installed'),
  mcpInstall: (item) => ipcRenderer.invoke('mcp:install', item),
  mcpUninstall: (params) => ipcRenderer.invoke('mcp:uninstall', params),
  mcpConnectAndRegister: (params) => ipcRenderer.invoke('mcp:connect-and-register', params),
});
