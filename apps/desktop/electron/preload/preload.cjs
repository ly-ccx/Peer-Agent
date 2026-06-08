const { contextBridge, ipcRenderer } = require('electron');

// 首屏初始设置：走 ipcRenderer.sendSync 让 main 同步读 ~/.zeusos/settings.json。
// 关键：不要在 preload 里 require('node:fs') —— sandbox preload 下 require Node 内置模块
// 会抛错、令整个 preload 脚本崩溃、contextBridge 不暴露 window.zeusAtlas，表现为
// "Zeus Atlas desktop preload is not available"。同步性由 sendSync 保证（首屏无闪烁）。
function readInitialSettings() {
  try {
    const result = ipcRenderer.sendSync('settings:get-sync');
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch {
    /* main 未就绪/异常 → 空对象，renderer 落默认 */
  }
  return {};
}

contextBridge.exposeInMainWorld('zeusAtlas', {
  // 首屏同步设置（preload 启动时读一次）；写走 updateSettings 异步落盘。
  initialSettings: readInitialSettings(),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  exportConfig: () => ipcRenderer.invoke('settings:export'),
  importConfig: () => ipcRenderer.invoke('settings:import'),
  getBootstrap: () => ipcRenderer.invoke('bootstrap:get'),
  getClientSession: () => ipcRenderer.invoke('session:get'),
  listCapabilities: () => ipcRenderer.invoke('capabilities:list'),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getCloudRuntime: () => ipcRenderer.invoke('cloud-runtime:get'),
  probeCloudContracts: () => ipcRenderer.invoke('cloud-contracts:probe'),
  getDeveloperSettings: () => ipcRenderer.invoke('developer-settings:get'),
  updateDeveloperSettings: (settings) => ipcRenderer.invoke('developer-settings:update', settings),
  resetDeveloperSettings: () => ipcRenderer.invoke('developer-settings:reset'),
  getDeveloperDiagnostics: () => ipcRenderer.invoke('developer-settings:diagnostics'),
  getRuntimeProjection: () => ipcRenderer.invoke('runtime-projection:get'),
  publishRuntimeProjection: () => ipcRenderer.invoke('runtime-projection:publish'),
  getAuthState: () => ipcRenderer.invoke('auth:get'),
  login: () => ipcRenderer.invoke('auth:login'),
  cancelLogin: () => ipcRenderer.invoke('auth:cancel-login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  setLocale: (locale) => ipcRenderer.invoke('locale:set', { locale }),
  approveLocalAction: (toolCallId) => ipcRenderer.invoke('permission:approve', { toolCallId }),
  denyLocalAction: (toolCallId) => ipcRenderer.invoke('permission:deny', { toolCallId }),
  executeClientToolCall: (call, grant) => ipcRenderer.invoke('client-tool:execute', { call, grant }),
  runHealthCheck: (toolCallId) => ipcRenderer.invoke('core:health', { toolCallId }),
  searchStaff: (params) => ipcRenderer.invoke('staff:search', params),
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

  // ── OTA 更新 ──
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateCurrentVersion: () => ipcRenderer.invoke('update:current-version'),
  onUpdateAvailable: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('update:available', handler);
    return () => ipcRenderer.removeListener('update:available', handler);
  },
  onUpdateProgress: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },
  onUpdateDownloaded: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('update:downloaded', handler);
    return () => ipcRenderer.removeListener('update:downloaded', handler);
  },
  onUpdateError: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('update:error', handler);
    return () => ipcRenderer.removeListener('update:error', handler);
  },
  mcpListInstalled: () => ipcRenderer.invoke('mcp:list-installed'),
  mcpInstall: (item) => ipcRenderer.invoke('mcp:install', item),
  mcpUninstall: (params) => ipcRenderer.invoke('mcp:uninstall', params),
  mcpListDingtalkMarket: (params) => ipcRenderer.invoke('mcp:list-dingtalk-market', params),
  mcpGetDingtalkDetail: (params) => ipcRenderer.invoke('mcp:get-dingtalk-detail', params),
  mcpProbe: (params) => ipcRenderer.invoke('mcp:probe', params),
  mcpListAoneMarket: (params) => ipcRenderer.invoke('mcp:list-aone-market', params),
  mcpListAoneMcpServers: (params) => ipcRenderer.invoke('mcp:list-aone-mcp-servers', params),
  mcpGetAoneMcpDetail: (params) => ipcRenderer.invoke('mcp:get-aone-mcp-detail', params),
  mcpDingtalkActivate: (params) => ipcRenderer.invoke('mcp:dingtalk-activate', params),
  mcpDingtalkAuthStatus: () => ipcRenderer.invoke('mcp:dingtalk-auth-status'),
  mcpConnectAndRegister: (params) => ipcRenderer.invoke('mcp:connect-and-register', params),
  skillListDingtalkMarket: (params) => ipcRenderer.invoke('skill:list-dingtalk-market', params),
  skillListAoneMarket: (params) => ipcRenderer.invoke('skill:list-aone-market', params),
  skillAoneEnsureAuth: () => ipcRenderer.invoke('skill:aone-ensure-auth'),
  skillAoneLogin: () => ipcRenderer.invoke('skill:aone-login'),
  skillInstallAone: (params) => ipcRenderer.invoke('skill:install-aone', params),
  skillInstallDingtalk: (params) => ipcRenderer.invoke('skill:install-dingtalk', params),
  chat: {
    listConversations: (params) => ipcRenderer.invoke('chat:conversations:list', params),
    createConversation: (params) => ipcRenderer.invoke('chat:conversations:create', params),
    getConversationDetail: (params) => ipcRenderer.invoke('chat:conversations:detail', params),
    deleteConversation: (params) => ipcRenderer.invoke('chat:conversations:delete', params),
    branchFromMessage: (params) => ipcRenderer.invoke('chat:conversations:branch-from-message', params),
    getMessages: (params) => ipcRenderer.invoke('chat:messages:list', params),
    getMessageDetail: (params) => ipcRenderer.invoke('chat:messages:detail', params),
    buildMessageContext: (params) => ipcRenderer.invoke('chat:messages:context', params),
    getLastMessage: (params) => ipcRenderer.invoke('chat:messages:last', params),
    deleteMessage: (params) => ipcRenderer.invoke('chat:messages:delete', params),
    truncateAfterMessage: (params) => ipcRenderer.invoke('chat:messages:truncate-after', params),
    uploadImage: (params) => ipcRenderer.invoke('chat:image:upload', params),
    startMessageStream: (params) => ipcRenderer.invoke('chat:messages:stream-start', params),
    abortMessageStream: (streamId) => ipcRenderer.invoke('chat:messages:stream-abort', { streamId }),
    cancelStream: (params) => ipcRenderer.invoke('chat:messages:cancel', params),
    confirmExecution: (params) => ipcRenderer.invoke('chat:execution:confirm', params),
    getExecutionStatus: (params) => ipcRenderer.invoke('chat:execution:status', params),
    getExecutionDetail: (params) => ipcRenderer.invoke('chat:execution:detail', params),
    getExecutionResult: (params) => ipcRenderer.invoke('chat:execution:result', params),
    getExecutionCot: (params) => ipcRenderer.invoke('chat:execution:cot', params),
    traceExecutionSource: (params) => ipcRenderer.invoke('chat:execution:source-trace', params),
    listExecutions: (params) => ipcRenderer.invoke('chat:execution:list', params),
    listRelatedShadowExecutions: (params) => ipcRenderer.invoke('chat:execution:shadow-related', params),
    cancelExecution: (params) => ipcRenderer.invoke('chat:execution:cancel', params),
    getPendingDispatch: (params) => ipcRenderer.invoke('chat:dispatch:pending', params),
    confirmDispatch: (params) => ipcRenderer.invoke('chat:dispatch:confirm', params),
    pollExecutionEvents: (params) => ipcRenderer.invoke('chat:execution:poll', params),
    getThinkingDetail: (params) => ipcRenderer.invoke('chat:thinking:detail', params),
    updateThinkingUiState: (params) => ipcRenderer.invoke('chat:thinking:ui-state:update', params),
    getAssistantSuggestions: (params) => ipcRenderer.invoke('chat:assistant:suggestions', params),
    getInlineCompletion: (params) => ipcRenderer.invoke('chat:assistant:inline-completion', params),
    getAgentById: (params) => ipcRenderer.invoke('chat:agents:get', params),
    listAgents: (params) => ipcRenderer.invoke('chat:agents:list', params),
    getWorkingMemory: (params) => ipcRenderer.invoke('chat:memory:working:get', params),
    initializeWorkingMemory: (params) => ipcRenderer.invoke('chat:memory:working:initialize', params),
    getMemoryWikiStatus: (params) => ipcRenderer.invoke('chat:memory:wiki:status', params),
    listMemoryWikiPages: (params) => ipcRenderer.invoke('chat:memory:wiki:pages', params),
    readMemoryWikiPage: (params) => ipcRenderer.invoke('chat:memory:wiki:page', params),
    initializeMemoryWiki: (params) => ipcRenderer.invoke('chat:memory:wiki:initialize', params),
    getBillingSummary: (params) => ipcRenderer.invoke('chat:billing:summary', params),
    getAgentDailyBilling: (params) => ipcRenderer.invoke('chat:billing:agent-daily', params),
    getMemoryCompileStatus: (params) => ipcRenderer.invoke('chat:memory:compile:status', params),
    retryMemoryCompile: (params) => ipcRenderer.invoke('chat:memory:compile:retry', params),
    listThinkingProcesses: (params) => ipcRenderer.invoke('chat:thinking:list', params),
    getThinkingByMessage: (params) => ipcRenderer.invoke('chat:thinking:by-message', params),
    createShare: (params) => ipcRenderer.invoke('chat:share:create', params),
    listShares: (params) => ipcRenderer.invoke('chat:share:list', params),
    getShareDetail: (params) => ipcRenderer.invoke('chat:share:detail', params),
    continueShare: (params) => ipcRenderer.invoke('chat:share:continue', params),
    revokeShare: (params) => ipcRenderer.invoke('chat:share:revoke', params),
    checkAccess: (params) => ipcRenderer.invoke('chat:access:check', params),
    updateSpectatorConfig: (params) => ipcRenderer.invoke('chat:access:spectator:update', params),
    createConversationAuth: (params) => ipcRenderer.invoke('chat:access:conversation-auth:create', params),
    getConversationAuthDetail: (params) => ipcRenderer.invoke('chat:access:conversation-auth:detail', params),
    updateConversationAuthMembers: (params) => ipcRenderer.invoke('chat:access:conversation-auth-members:update', params),
    listAuthBase: (params) => ipcRenderer.invoke('chat:access:auth-base:list', params),
    updateShareAccess: (params) => ipcRenderer.invoke('chat:access:share:update', params),
    createShareAuth: (params) => ipcRenderer.invoke('chat:access:share-auth:create', params),
    getShareAuthDetail: (params) => ipcRenderer.invoke('chat:access:share-auth:detail', params),
    updateShareAuthMembers: (params) => ipcRenderer.invoke('chat:access:share-auth-members:update', params),
    listAgentCronSessions: (params) => ipcRenderer.invoke('chat:automation:sessions:list', params),
    getAgentCronSessionDetail: (params) => ipcRenderer.invoke('chat:automation:sessions:detail', params),
    createAgentCronSession: (params) => ipcRenderer.invoke('chat:automation:sessions:create', params),
    updateAgentCronSession: (params) => ipcRenderer.invoke('chat:automation:sessions:update', params),
    pauseAgentCronSession: (params) => ipcRenderer.invoke('chat:automation:sessions:pause', params),
    resumeAgentCronSession: (params) => ipcRenderer.invoke('chat:automation:sessions:resume', params),
    completeAgentCronSession: (params) => ipcRenderer.invoke('chat:automation:sessions:complete', params),
    recoverAgentCronSessionOpenRuns: (params) => ipcRenderer.invoke('chat:automation:sessions:recover-open-runs', params),
    listAgentCronRuns: (params) => ipcRenderer.invoke('chat:automation:runs:list', params),
    injectRoundTableTurn: (params) => ipcRenderer.invoke('chat:roundtable:inject', params),
    abortRoundTableTurn: (params) => ipcRenderer.invoke('chat:roundtable:abort', params),
    getRoundTableTranscript: (params) => ipcRenderer.invoke('chat:roundtable:transcript', params),
    updateAgentMemoryPatchStatus: (params) => ipcRenderer.invoke('chat:agent-memory:patch:update-status', params),
    getMessageTrace: (params) => ipcRenderer.invoke('chat:trace:message-detail', params),
    getConversationTrace: (params) => ipcRenderer.invoke('chat:trace:conversation-detail', params),
    getToolCallDetail: (params) => ipcRenderer.invoke('chat:tool-calls:detail', params),
    listToolCalls: (params) => ipcRenderer.invoke('chat:tool-calls:list', params),
    getConversationToolCallStatistics: (params) => ipcRenderer.invoke('chat:tool-calls:statistics:conversation', params),
    getRecentToolCalls: (params) => ipcRenderer.invoke('chat:tool-calls:recent', params),
    getMessageToolCalls: (params) => ipcRenderer.invoke('chat:tool-calls:message', params),
    getChatStatisticsOverview: (params) => ipcRenderer.invoke('chat:statistics:overview', params),
    getChatStatisticsTrends: (params) => ipcRenderer.invoke('chat:statistics:trends', params),
    getChatStatisticsToolRanking: (params) => ipcRenderer.invoke('chat:statistics:tools-ranking', params),
    getChatStatisticsUserRanking: (params) => ipcRenderer.invoke('chat:statistics:users-ranking', params),
    getChatStatisticsRealtime: (params) => ipcRenderer.invoke('chat:statistics:realtime', params),
    exportChatStatistics: (params) => ipcRenderer.invoke('chat:statistics:export-cloud', params),
    exportChatStatisticsSnapshot: (params) => ipcRenderer.invoke('chat:statistics:export-local', params),
    getOpenClawCurrentScene: () => ipcRenderer.invoke('chat:studio:scene-current'),
    getOpenClawSceneEvents: (params) => ipcRenderer.invoke('chat:studio:scene-events', params),
    listOpenClawAgentChannels: (params) => ipcRenderer.invoke('chat:studio:agent-channels', params),
    listOpenClawAgentChannelSessions: (params) => ipcRenderer.invoke('chat:studio:channel-sessions', params),
    enterOpenClawAgentChat: (params) => ipcRenderer.invoke('chat:studio:agent-chat-enter', params),
    enterOpenClawAgentChannelSession: (params) => ipcRenderer.invoke('chat:studio:channel-session-enter', params),
    getOpenClawGovernanceCatalog: () => ipcRenderer.invoke('chat:openclaw-governance:catalog'),
    listOpenClawIdentityProfiles: () => ipcRenderer.invoke('chat:openclaw-governance:identity-profiles'),
    listOpenClawRolePostures: () => ipcRenderer.invoke('chat:openclaw-governance:role-postures'),
    listOpenClawUnifiedServiceRefs: () => ipcRenderer.invoke('chat:openclaw-governance:unified-service-refs'),
    listOpenClawCapabilityProfiles: () => ipcRenderer.invoke('chat:openclaw-governance:capability-profiles'),
    listOpenClawMemoryPacks: () => ipcRenderer.invoke('chat:openclaw-governance:memory-packs'),
    listOpenClawSeedMemoryPacks: () => ipcRenderer.invoke('chat:openclaw-governance:seed-memory-packs'),
    listOpenClawMemoryBindingPolicies: () => ipcRenderer.invoke('chat:openclaw-governance:memory-binding-policies'),
    listOpenClawMemoryWorkspaces: () => ipcRenderer.invoke('chat:openclaw-governance:memory-workspaces'),
    listOpenClawMemorySnapshots: () => ipcRenderer.invoke('chat:openclaw-governance:memory-snapshots'),
    listOpenClawMemoryTrainingRuns: () => ipcRenderer.invoke('chat:openclaw-governance:memory-training-runs'),
    listOpenClawTrainingScorecards: () => ipcRenderer.invoke('chat:openclaw-governance:training-scorecards'),
    listOpenClawLearningSamples: () => ipcRenderer.invoke('chat:openclaw-governance:learning-samples'),
    listOpenClawMemoryCandidates: () => ipcRenderer.invoke('chat:openclaw-governance:memory-candidates'),
    listOpenClawZeusBackflowExports: () => ipcRenderer.invoke('chat:openclaw-governance:zeus-backflow-exports'),
    listOpenClawModelPolicies: () => ipcRenderer.invoke('chat:openclaw-governance:model-policies'),
    listOpenClawCredentialProfiles: () => ipcRenderer.invoke('chat:openclaw-governance:credential-profiles'),
    listOpenClawEvalSuites: () => ipcRenderer.invoke('chat:openclaw-governance:eval-suites'),
    listOpenClawSimulationEvals: () => ipcRenderer.invoke('chat:openclaw-governance:simulation-evals'),
    listOpenClawCertifications: () => ipcRenderer.invoke('chat:openclaw-governance:certifications'),
    listOpenClawAgentReleases: () => ipcRenderer.invoke('chat:openclaw-governance:agent-releases'),
    listOpenClawReleaseChannels: () => ipcRenderer.invoke('chat:openclaw-governance:release-channels'),
    listOpenClawOnDutyPolicies: () => ipcRenderer.invoke('chat:openclaw-governance:on-duty-policies'),
    listOpenClawSchedulePolicies: () => ipcRenderer.invoke('chat:openclaw-governance:schedule-policies'),
    listOpenClawAlertPolicies: () => ipcRenderer.invoke('chat:openclaw-governance:alert-policies'),
    listOpenClawAlertIncidents: () => ipcRenderer.invoke('chat:openclaw-governance:alert-incidents'),
    listOpenClawRemediationPolicies: () => ipcRenderer.invoke('chat:openclaw-governance:remediation-policies'),
    listOpenClawRemediationActions: () => ipcRenderer.invoke('chat:openclaw-governance:remediation-actions'),
    listOpenClawHumanTakeovers: () => ipcRenderer.invoke('chat:openclaw-governance:human-takeovers'),
    listOpenClawUpgradeJobs: () => ipcRenderer.invoke('chat:openclaw-governance:upgrade-jobs'),
    resolveOpenClawEffectiveAgentConfig: (params) => ipcRenderer.invoke('chat:openclaw-governance:effective-agent-config', params),
    resolveOpenClawConversationEffectiveConfig: (params) => ipcRenderer.invoke('chat:openclaw-governance:conversation-effective-config', params),
    reportClientToolResult: (params) => ipcRenderer.invoke('chat:client-tool:result', params),
    pollClientToolCalls: (params) => ipcRenderer.invoke('chat:client-tool:poll', params),
    onStreamEvent: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('chat:stream:event', handler);
      return () => ipcRenderer.removeListener('chat:stream:event', handler);
    },
    onStreamDone: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('chat:stream:done', handler);
      return () => ipcRenderer.removeListener('chat:stream:done', handler);
    },
    onStreamError: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('chat:stream:error', handler);
      return () => ipcRenderer.removeListener('chat:stream:error', handler);
    },
  },
});
