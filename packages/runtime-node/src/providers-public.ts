/** Stable providers entry; implementations do not re-export the aggregate root. */
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
export { createNodeRuntimeHostAdapter } from './host-adapter.ts';
export { createProviderRuntimeClock, createNodeResultFactory, appendNodeHookEvidence } from './provider-utils.ts';
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
export { effectiveFastMode, supportsFastMode } from './fast-mode.ts';
export { openSqlite } from './sqlite/open-sqlite.mjs';
export { createFtsIndex } from './sqlite/fts-index.mjs';
export { loadMigratedSettings, runSettingsMigrations, SETTINGS_MIGRATIONS } from './settings-migrations.mjs';
export {
  createProjectRegistry,
  defaultProjectRegistryFile,
  isRemoteWorkspaceId,
  readRemoteAliases,
} from './project-registry.mjs';
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
export { createMcpRegistry, slugifyMcpId } from './mcp-registry.mjs';
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
export {
  ensureFreshGoogleTokens,
  refreshGoogleAccessToken,
  startGoogleBrowserLogin,
} from './llm-oauth/google-oauth.mjs';
export { createAccountUsageAdapters } from './account-usage-adapters.mjs';
export {
  emptyModelResponseCorrection,
  emptyModelResponseError,
  hasEmptyWriteNarration,
  hasIncompleteActionNarration,
  hasLiteralToolCallSyntax,
  hasUnsupportedToolClaim,
  shouldRetryNoToolResponse,
  thinkingOnlyResponseCorrection,
  thinkingOnlyResponseError,
  unsupportedToolResponseCorrection,
  unsupportedToolResponseError,
} from './chat-runtime/response-guard.mjs';
export { startRemoteDeviceConnector } from './remote-device-connector.mjs';
export { createRemoteBindingStore } from './remote-binding-store.mjs';
export { createRemoteReceiptStore } from './remote-receipt-store.mjs';
export { createLocalImageProvider, detectLocalImageMediaType, isLocalImageObservation } from './local-image-provider.mjs';
export { LOCAL_IMAGE_TOOL_DEFINITIONS } from './local-image-tools.mjs';
export {
  LOCAL_IMAGE_CONTEXT_PREFIX,
  checkpointWithoutLocalImagePixels,
  bindLocalImageContextBlock,
  createLocalImageContinuationStore,
  localImageContinuations,
} from './local-image-checkpoint.mjs';
export { createLocalGitProvider } from './local-git-provider.mjs';
export { LOCAL_GIT_TOOL_DEFINITIONS } from './local-git-tools.mjs';
export { createNodeGitProvider, NODE_GIT_CAPABILITY_MANIFESTS } from './git-provider.ts';
