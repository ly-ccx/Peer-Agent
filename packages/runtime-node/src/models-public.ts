/** Stable models entry; implementations do not re-export the aggregate root. */
export {
  GROK_SUBSCRIPTION_BASE_URL,
  GROK_STABLE_RELEASE_URL,
  GROK_SUBSCRIPTION_HEADERS,
  buildGrokSubscriptionHeaders,
  createGrokSubscriptionTransport,
  grokSubscriptionTransport,
  formatGrokSubscriptionHttpError,
} from './grok-subscription-transport.mjs';
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
export type { CreateChatGptResponsesProviderOptions } from './chatgpt-responses-provider.ts';
export { createChatGptResponsesProvider } from './chatgpt-responses-provider.ts';
export { refreshChatGptOAuthTokens } from './chatgpt-oauth.ts';
export {
  buildDefaultModelRouting,
  catalogFromProviders,
  evaluateRoleSpendCap,
  isRoutableProvider,
  providerFamily,
  resolveRoleRoute,
  resolveStoredModelRouting,
} from './model-router.mjs';
export { sendAnthropicMessagesStream } from './provider-adapters/anthropic-messages-adapter.mjs';
export { sendGeminiStream } from './provider-adapters/gemini-adapter.mjs';
export {
  contextCountCapabilityForProvider,
  countAnthropicCanonicalRequest,
  countGeminiCanonicalRequest,
} from './provider-adapters/context-count-adapter.mjs';
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
export { emitToolArgProgress } from './provider-adapters/tool-arg-progress.mjs';
export { resolveOpenCodeGoWire, resolveOpenCodeGoBaseUrl } from './model-channel-wire.mjs';
export {
  parseSseDataPayload,
  createSseAbortError,
  createSseIdleTimeoutError,
  throwIfSseReaderAborted,
  readSseChunk,
  cancelSseReader,
} from './provider-adapters/sse-line.mjs';
