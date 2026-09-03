export type {
  CreateNodeRuntimeHostAdapterOptions,
  NodeRuntimeApprovalDecision,
  NodeRuntimeApprovalRequest,
  NodeRuntimeCapabilityPermissionPrompt,
  NodeRuntimeExecutionContext,
  NodeRuntimeHookPermissionPrompt,
  NodeRuntimePermissionPrompt,
  NodeRuntimePermissionResponse,
  NodeRuntimeProviderExecutor,
  NodeRuntimeResultFactory,
  NodeRuntimeSession,
} from './contracts.ts';
export type {
  CreateNodeProviderBundleOptions,
  NodeCapabilityApprovalKind,
  NodeCapabilityApprovalPort,
  NodeCapabilityPermissionPrompt,
  NodeFileProviderOptions,
  NodeProviderBundle,
  NodeShellProviderOptions,
} from './provider-contracts.ts';
export {
  FileReadRangeError,
  formatNumberedLines,
  parseFileReadLineRange,
  sliceFileReadLines,
  splitFileLines,
} from './file-read-range.ts';
export type { FileReadLineRange, FileReadSlice } from './file-read-range.ts';
export { createNodeFileProvider, NODE_FILE_CAPABILITY_MANIFESTS } from './file-provider.ts';
export {
  enforceConversationArtifactBudget,
  materializeToolResultContent,
  removeConversationToolArtifacts,
  resolveToolArtifactDir,
  TOOL_RESULT_MATERIALIZE_CONFIG,
  writeToolResultArtifact,
} from './tool-artifact-store.ts';
export type { MaterializedToolResult, ToolResultArtifact } from './tool-artifact-store.ts';
export {
  encodeProviderToolResult,
  FILE_READ_INLINE_MAX_CHARS,
  SHELL_CONTEXT_PREVIEW_CHARS,
} from './tool-result-encoder.ts';
export type { EncodeProviderToolResultInput } from './tool-result-encoder.ts';
export {
  createNodeInteractionProvider,
  INTERACTION_CAPABILITY_ID,
  NODE_INTERACTION_CAPABILITY_MANIFESTS,
  REQUEST_USER_INPUT_TOOL_NAME,
} from './interaction-provider.ts';
export type {
  ModelReasoningEffort,
  RuntimeModelCatalogEntry,
  RuntimeModelSelection,
  RuntimePermissionPolicy,
} from './model-catalog.ts';
export {
  isRuntimeModelSelectionAvailable,
  normalizeModelReasoningEffort,
  normalizeRuntimePermissionPolicy,
  RUNTIME_PERMISSION_POLICIES,
} from './model-catalog.ts';
export type {
  ModelContentPart,
  ModelCredential,
  ModelCredentialPort,
  ModelCredentialRequest,
  ModelImageUrlContentPart,
  ModelMessage,
  ModelMessageContent,
  ModelMessageRole,
  ModelProvider,
  ModelProviderRequest,
  ModelProviderResult,
  ModelStreamEvent,
  ModelTextContentPart,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
  OpenAICompatibleProviderConfig,
} from './model-provider-contracts.ts';
export {
  ModelCredentialNotFoundError,
  resolveOpenAICompatibleProviderConfig,
} from './model-provider-contracts.ts';
export type { CreateOpenAICompatibleProviderOptions } from './openai-compatible-provider.ts';
export type {
  ConsumeOpenAIChatStreamOptions,
  OpenAIChatStreamError,
  OpenAIChatStreamResult,
} from './openai-chat-stream.ts';
export {
  consumeOpenAIChatStream,
  ModelProviderStreamError,
} from './openai-chat-stream.ts';
export {
  createOpenAICompatibleProvider,
  ModelProviderHttpError,
} from './openai-compatible-provider.ts';
export { createNodeRuntimeHostAdapter } from './host-adapter.ts';
export { createNodeProviderBundle } from './provider-bundle.ts';
export {
  createNodeSearchAggregateProvider,
  NODE_SEARCH_AGGREGATE_CAPABILITY_MANIFESTS,
} from './search-aggregate-provider.ts';
export {
  classifyNodeShellCommand,
  compareNodeShellRisk,
  NODE_SHELL_RISK_ORDER,
  normalizeNodeShellCwd,
} from './shell-classifier.ts';
export { createNodeShellProvider, NODE_SHELL_CAPABILITY_MANIFESTS } from './shell-provider.ts';
export type { NodeShellProvider } from './shell-provider.ts';
export {
  createNodeShellSessionManager,
  resolvePersistentShellPath,
  sessionConversationKey,
  supportsPersistentShellSession,
} from './shell-session.ts';
export type {
  CreateNodeShellSessionManagerOptions,
  NodeShellSessionCommandResult,
  NodeShellSessionManager,
  NodeShellSessionStatus,
  RunNodeShellSessionCommandOptions,
} from './shell-session.ts';
export { createNodeShellArtifactStore } from './shell-artifact-store.ts';
export type {
  CreateNodeShellArtifactStoreOptions,
  NodeShellArtifactDescriptor,
  NodeShellArtifactMetadata,
  NodeShellArtifactSession,
  NodeShellArtifactStore,
} from './shell-artifact-store.ts';
export { createNodeShellTaskManager } from './shell-task-manager.ts';
export type {
  CreateNodeShellTaskManagerOptions,
  NodeShellStopResult,
  NodeShellTaskHandle,
  NodeShellTaskManager,
  NodeShellTaskOutput,
  NodeShellTaskSnapshot,
  NodeShellTaskStatus,
  RunNodeShellTaskOptions,
} from './shell-task-manager.ts';
export { createNodeWebArtifactStore } from './web-artifact-store.ts';
export { fetchNodeWebPage, normalizeWebUrl, stripHtml } from './web-fetch-engine.ts';
export type { NodeWebFetchProviderOptions } from './web-fetch-provider.ts';
export {
  createNodeWebFetchProvider,
  NODE_WEB_FETCH_CAPABILITY_MANIFESTS,
} from './web-fetch-provider.ts';
export type {
  CreateNodeHookRunnerOptions,
  NodeHookConfig,
  NodeHookDefinition,
  NodeHookEvent,
  NodeHookFailureMode,
} from './node-hook-runner.ts';
export {
  createNodeHookRunner,
  matchesNodeHook,
  mostRestrictiveNodeHookDecision,
} from './node-hook-runner.ts';
export type {
  CreateConfiguredNodeHookRunnerOptions,
  LoadNodeHookConfigOptions,
} from './node-hook-config.ts';
export {
  createConfiguredNodeHookRunner,
  getNodeHookConfigPaths,
  loadNodeHookConfig,
  mergeNodeHookConfigs,
} from './node-hook-config.ts';
export type {
  ChatGptOAuthTokens,
  LoadSharedModelSelectionOptions,
  SharedModelAuthMethod,
  SharedModelCredentialStore,
  SharedModelMetadata,
  SharedModelSelection,
  StoredModelProvider,
} from './shared-model-config.ts';
export {
  getSharedModelConfigPath,
  loadSharedModelMetadata,
  loadSharedModelMetadataList,
  loadSharedModelSelection,
  selectDesktopDefaultProvider,
} from './shared-model-config.ts';
export { effectiveFastMode, supportsFastMode } from './fast-mode.ts';
export type { CreateChatGptResponsesProviderOptions } from './chatgpt-responses-provider.ts';
export { createChatGptResponsesProvider } from './chatgpt-responses-provider.ts';
export { refreshChatGptOAuthTokens } from './chatgpt-oauth.ts';

// Shared Node Goal runtime. Desktop and TUI inject their host-specific chat,
// interaction, Explorer, Verifier, and notification ports into this one pump.
export {
  DATA_STORE_ENTRIES,
  exportBundle,
  getDataHome,
  importBundle,
  listEntries,
  migrateFromLegacy,
  pathOf,
} from './data-store.mjs';
export {
  aggregateProgress,
  applyGoalTimingTransition,
  canConsumeRequestedUserInput,
  createGoalPlanStore,
  derivePlanStatus,
  goalPlanIsSelfDriven,
  goalPlanRequiresApproval,
  normalizeGoalTiming,
} from './goal-plan-store.mjs';
export {
  attachWorkspaceHeadBinding,
  readWorkspaceHead,
  resolveWorkspaceHead,
} from './goal-delivery-binding.mjs';
export {
  automationRunIsTerminal,
  createAutomationStore,
} from './automation-store.mjs';
export {
  automationOccurrences,
  latestAutomationOccurrence,
  nextAutomationOccurrence,
  parseAutomationCron,
  validateAutomationSchedule,
} from './automation-schedule.mjs';
export {
  automationIdempotencyKey,
  completeOnceAutomationIfNeeded,
  createAutomationScheduler,
  reconcileAutomationSchedules,
} from './automation-scheduler.mjs';
export {
  computePlanScopeSnapshot,
  computeReanchorInterval,
  createDeterministicExplorePlan,
  createGoalRunner,
  detectPlanDrift,
  evaluateVerificationGate,
  shouldReanchor,
} from './goal-runner.mjs';
export {
  decideIntakeConvergence,
  isIntakeContract,
  isStalledAcceptedGoalRunner,
  serializeAcceptedGoalRunnerHandoff,
  shouldAutoStartAcceptedGoalRunner,
  shouldAutoStartAcceptedGoalRunnerFromChange,
  shouldRearmFailedGoalPlanFromChange,
  shouldResumeGoalRunnerAfterUserDecision,
  shouldRecoverAcceptedGoalRunnerOnConversationOpen,
} from './goal-intake-convergence.mjs';

// Shared Node Skill/MCP runtime. Hosts own discovery, authorization UI, and
// lifecycle wiring; this package owns the reusable registries, providers,
// client transport, tool projection, and structured result construction.
export { createMcpRegistry, slugifyMcpId } from './mcp-registry.mjs';
export { createSkillStore } from './skill-store.mjs';
export {
  __mcpClientInternals,
  callMcpTool,
  disconnectAll,
  disconnectMcp,
  discoverMcpManifest,
  finishMcpOAuth,
  getMcpPrompt,
  listMcpTools,
  normalizeMcpToolResult,
  probeMcpConnection,
  readMcpResource,
  startMcpOAuth,
  testMcpConnection,
} from './mcp-client.mjs';
export { createLocalMcpProvider } from './local-mcp-provider.mjs';
export { createLocalSkillProvider } from './local-skill-provider.mjs';
export { createMcpToolDefinitionsFromRegistry } from './mcp-tool-definitions.mjs';
export {
  createSkillToolDefinition,
  createSkillToolDefinitionsFromStore,
  SKILL_PREFIX,
} from './skill-tool-definitions.mjs';
export {
  createFailedClientToolResult,
  createPermissionGrant,
  nowIso,
} from './tool-result-factory.mjs';

// Shared provider request/stream algorithms. Hosts must inject their network
// transport so Desktop keeps Electron net.fetch semantics while TUI keeps its
// proxy, trust-store, and recovery policy.
export { sendAnthropicMessagesStream } from './provider-adapters/anthropic-messages-adapter.mjs';
export { sendGeminiStream } from './provider-adapters/gemini-adapter.mjs';
export {
  contextCountCapabilityForProvider,
  countAnthropicCanonicalRequest,
  countGeminiCanonicalRequest,
} from './provider-adapters/context-count-adapter.mjs';
export {
  ensureFreshGoogleTokens,
  refreshGoogleAccessToken,
  startGoogleBrowserLogin,
} from './llm-oauth/google-oauth.mjs';
export {
  GROK_CLI_CLIENT_ID,
  GROK_LOGIN_SCOPE,
  GROK_OIDC_ISSUER,
  GROK_REQUIRED_API_SCOPE,
  ensureFreshGrokTokens,
  refreshGrokTokens,
  startGrokOAuthLogin,
} from './llm-oauth/grok-oauth.mjs';
export {
  clearSubscriptionQuotaCache,
  expireFreshSubscriptionQuotaCache,
  fetchChatGptUsage,
  fetchGeminiQuota,
  fetchGrokQuota,
  fetchProviderSubscriptionQuota,
  fetchQoderQuota,
  mapQoderUsageToQuota,
  resolveGeminiCodeAssistProjectId,
  supportsSubscriptionQuota,
} from './subscription-quota.mjs';
export {
  decryptQoderModelCache,
  extractEmbeddedAuthWasmBytes,
  loadQoderAccessToken,
  loadQoderLocalAuth,
  prepareQoderInferRequest,
  resolveHostNodeBinary,
  resolveQoderCliBinary,
  resolveQoderConfigDir,
  resolveQoderInferenceEndpoint,
} from './provider-adapters/qoder-local-auth.mjs';
export {
  getQoderModelCatalog,
  getQoderModelMetadata,
  listQoderModels,
  qoderModelsPathForDebug,
  resolveQoderModelOptionProjection,
} from './provider-adapters/qoder-model-catalog.mjs';
export {
  fetchOfficialQoderModelCatalog,
  fetchQoderUsageInfo,
} from './provider-adapters/qoder-official-model-catalog.mjs';
export {
  consumeOpenAIStream,
  sendOpenAIChatStream,
  shouldUsePublicOpenAIChatStream,
} from './provider-adapters/openai-chat-adapter.mjs';
export {
  emptyModelResponseCorrection,
  emptyModelResponseError,
  hasEmptyWriteNarration,
  hasLiteralToolCallSyntax,
  hasUnsupportedToolClaim,
  shouldRetryNoToolResponse,
  thinkingOnlyResponseCorrection,
  thinkingOnlyResponseError,
  unsupportedToolResponseCorrection,
  unsupportedToolResponseError,
} from './chat-runtime/response-guard.mjs';
export {
  QODER_CONNECTION_RETRY_DELAYS_MS,
  QODER_DUPLICATE_RETRY_DELAYS_MS,
  QODER_QUEUE_DEFAULT_WAIT_MS,
  QODER_QUEUE_LONG_WAIT_HINT_MS,
  QODER_QUEUE_MAX_RETRIES,
  QODER_QUEUE_MAX_WAIT_MS,
  QODER_QUEUE_TOTAL_BUDGET_MS,
  QODER_TRANSIENT_RETRY_DELAYS_MS,
  buildQoderPrivateHeaders,
  buildQoderPrivateRequestBody,
  buildQoderRemoteChatAsk,
  classifyQoderStreamFailure,
  computeQoderQueueWaitMs,
  formatQoderDuplicateError,
  formatQoderQueueError,
  formatQoderQueueStatusMessage,
  mergeConsecutiveAssistants,
  normalizeQoderModel,
  normalizeQoderPreparedEndpoint,
  qoderModelServerBaseUrl,
  qoderTurnTaskId,
  resolveQoderReasoningEffortParam,
  sanitizeQoderToolPairing,
  sendQoderPrivateStream,
} from './provider-adapters/qoder-private-adapter.mjs';
