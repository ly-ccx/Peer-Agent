import { startBrowserLogin, ensureFreshTokens } from './llm-oauth/openai-oauth.mjs';
import { startGoogleBrowserLogin, ensureFreshGoogleTokens } from './llm-oauth/google-oauth.mjs';
import { startGrokOAuthLogin, ensureFreshGrokTokens } from './llm-oauth/grok-oauth.mjs';
import { listSubscriptionModels, listOpenAICompatibleModels } from './provider-adapters/openai-model-catalog.mjs';
import { listGrokBuildModels } from './provider-adapters/grok-build-model-catalog.mjs';
import { listGeminiModels, preferGeminiModel } from './provider-adapters/gemini-model-catalog.mjs';
import { listQoderModels } from './provider-adapters/qoder-model-catalog.mjs';
import { resolveChannel } from './provider-channels.mjs';
import { resolveGeminiCodeAssistProjectId } from './subscription-quota.mjs';

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

const DEFAULT_OPERATIONS = Object.freeze({
  startBrowserLogin,
  startGoogleBrowserLogin,
  startGrokOAuthLogin,
  ensureFreshTokens,
  ensureFreshGoogleTokens,
  ensureFreshGrokTokens,
  listSubscriptionModels,
  listOpenAICompatibleModels,
  listGrokBuildModels,
  listGeminiModels,
  preferGeminiModel,
  listQoderModels,
  resolveChannel,
  resolveGeminiCodeAssistProjectId,
});

export function createProviderAccessApplicationService({
  fetchQuota,
  listProviders,
  addProvider,
  updateProvider,
  removeProvider,
  getCredential,
  setOAuthTokens,
  getApiKeyRequestConfig,
  fetchWithRecovery,
  openExternal,
  writeClipboard,
  sendOAuthEvent,
  recordBaseline,
  wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
  now = () => new Date().toISOString(),
  reportProjectResolutionError = () => {},
  operations = {},
} = {}) {
  const ports = {
    fetchQuota: assertFunction(fetchQuota, 'fetchQuota'),
    listProviders: assertFunction(listProviders, 'listProviders'),
    addProvider: assertFunction(addProvider, 'addProvider'),
    updateProvider: assertFunction(updateProvider, 'updateProvider'),
    removeProvider: assertFunction(removeProvider, 'removeProvider'),
    getCredential: assertFunction(getCredential, 'getCredential'),
    setOAuthTokens: assertFunction(setOAuthTokens, 'setOAuthTokens'),
    getApiKeyRequestConfig: assertFunction(getApiKeyRequestConfig, 'getApiKeyRequestConfig'),
    fetchWithRecovery: assertFunction(fetchWithRecovery, 'fetchWithRecovery'),
    openExternal: assertFunction(openExternal, 'openExternal'),
    writeClipboard: assertFunction(writeClipboard, 'writeClipboard'),
    sendOAuthEvent: assertFunction(sendOAuthEvent, 'sendOAuthEvent'),
    recordBaseline: assertFunction(recordBaseline, 'recordBaseline'),
    wait: assertFunction(wait, 'wait'),
    now: assertFunction(now, 'now'),
    reportProjectResolutionError: assertFunction(
      reportProjectResolutionError,
      'reportProjectResolutionError',
    ),
  };
  const ops = Object.freeze({ ...DEFAULT_OPERATIONS, ...operations });
  let activeOAuthLogin = null;
  let activeOAuthVerificationUrl = null;

  function providerById(id) {
    return ports.listProviders().find((provider) => provider.id === id) ?? null;
  }

  function cancelActiveOAuth() {
    if (activeOAuthLogin) {
      try { activeOAuthLogin.cancel(); } catch {}
      activeOAuthLogin = null;
    }
    activeOAuthVerificationUrl = null;
  }

  async function startOAuth(caller, params = {}) {
    const id = params?.id ?? null;
    const draft = params?.draft ?? null;
    if (!id && !draft) throw new Error('provider id or draft required');
    const existing = id ? providerById(id) : null;
    const authMethod = draft?.authMethod || existing?.authMethod || 'oauth_chatgpt';
    if (!['oauth_chatgpt', 'oauth_google', 'oauth_grok'].includes(authMethod)) {
      throw new Error(`unsupported_oauth_method:${authMethod}`);
    }
    if (activeOAuthLogin) {
      cancelActiveOAuth();
      await ports.wait(200);
    }

    const session = authMethod === 'oauth_google'
      ? ops.startGoogleBrowserLogin()
      : authMethod === 'oauth_grok'
        ? ops.startGrokOAuthLogin({
          fetchImpl: (url, init) => ports.fetchWithRecovery(url, init, {
            provider: 'grok',
            model: 'oauth',
            maxRetries: 1,
          }),
          openExternal: async (url) => {
            activeOAuthVerificationUrl = url;
            await ports.openExternal(url);
          },
          onPending: (pending) => {
            activeOAuthVerificationUrl = pending.verificationUrl;
            ports.writeClipboard(pending.userCode);
            ports.sendOAuthEvent(caller, 'llm:oauth:pending', pending);
          },
          onTokenReady: () => ports.sendOAuthEvent(caller, 'llm:oauth:authorized'),
        })
        : ops.startBrowserLogin();

    activeOAuthLogin = session;
    let createdId = null;
    try {
      const tokens = await session.promise;
      const targetId = id ?? (createdId = ports.addProvider({ ...draft, authMethod }).id);
      ports.setOAuthTokens(targetId, tokens);
      let provider = providerById(targetId);
      let models = null;

      if (authMethod === 'oauth_grok') {
        const catalog = await ops.listGrokBuildModels(tokens.access, { baseUrl: provider?.baseUrl });
        models = catalog.models;
        const preferred = models.find((model) => model.id === 'grok-4.5') ?? models[0] ?? null;
        if (preferred && provider?.model !== preferred.id) {
          provider = ports.updateProvider(targetId, {
            model: preferred.id,
            contextWindow: preferred.contextWindow,
            supportsVision: preferred.supportsVision,
            supportsReasoning: preferred.supportsReasoning,
          });
        }
      } else if (authMethod === 'oauth_google') {
        const catalog = await ops.listGeminiModels(tokens);
        models = catalog.models;
        const preferred = ops.preferGeminiModel(models);
        let oauthProjectId = null;
        try {
          oauthProjectId = await ops.resolveGeminiCodeAssistProjectId({
            accessToken: tokens.access,
            fetchImpl: (url, init) => ports.fetchWithRecovery(url, init),
          });
        } catch (error) {
          ports.reportProjectResolutionError(error);
        }
        if (preferred?.id || oauthProjectId) {
          provider = ports.updateProvider(targetId, {
            ...(preferred?.id ? {
              model: preferred.id,
              modelLabel: preferred.label || preferred.id,
              contextWindow: preferred.contextWindow,
              maxOutputTokens: preferred.maxOutputTokens,
              metadataSource: catalog.source || 'builtin',
              metadataSyncedAt: ports.now(),
            } : {}),
            ...(oauthProjectId ? { oauthProjectId } : {}),
          }) || provider;
        }
      }
      if (provider) ports.recordBaseline('oauth_login', provider);
      return { success: true, provider, models };
    } catch (error) {
      if (createdId) {
        try { ports.removeProvider(createdId); } catch {}
      }
      return { success: false, error: error?.message || 'oauth_login_failed' };
    } finally {
      if (activeOAuthLogin === session) {
        activeOAuthLogin = null;
        activeOAuthVerificationUrl = null;
      }
    }
  }

  async function openPendingOAuth() {
    if (!activeOAuthLogin || !activeOAuthVerificationUrl) {
      return { success: false, error: 'oauth_pending_url_unavailable' };
    }
    try {
      await ports.openExternal(activeOAuthVerificationUrl);
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message || 'oauth_open_browser_failed' };
    }
  }

  async function listModels(id) {
    if (!id) throw new Error('provider id required');
    const credential = ports.getCredential(id);
    const provider = providerById(id);
    const authMethod = credential?.authMethod || provider?.authMethod || 'oauth_chatgpt';
    if (
      authMethod === 'qoder_local_auth'
      || authMethod === 'local_cli'
      || provider?.channelId === 'qoder'
    ) {
      const { models, source, error } = await ops.listQoderModels();
      return { success: true, models, source, error };
    }
    if (authMethod === 'api_key') {
      const requestConfig = ports.getApiKeyRequestConfig(id);
      if (!requestConfig) return { success: false, models: [], error: 'api_key_not_configured' };
      try {
        const { models, source } = await ops.listOpenAICompatibleModels(requestConfig);
        return { success: true, models, source };
      } catch (error) {
        return { success: false, models: [], error: error?.message || 'models_list_failed' };
      }
    }
    const tokens = credential?.tokens || null;
    if (!tokens?.access) return { success: false, models: [], error: 'oauth_not_logged_in' };
    try {
      const { tokens: fresh, refreshed } = authMethod === 'oauth_google'
        ? await ops.ensureFreshGoogleTokens(tokens)
        : authMethod === 'oauth_grok'
          ? await ops.ensureFreshGrokTokens(tokens)
          : await ops.ensureFreshTokens(tokens);
      if (refreshed) ports.setOAuthTokens(id, fresh);
      const { models, source, error } = authMethod === 'oauth_google'
        ? await ops.listGeminiModels(fresh)
        : authMethod === 'oauth_grok'
          ? await ops.listGrokBuildModels(fresh.access, { baseUrl: provider?.baseUrl })
          : await ops.listSubscriptionModels(fresh);
      return { success: true, models, source, error };
    } catch (error) {
      return { success: false, models: [], error: error?.message || 'models_list_failed' };
    }
  }

  async function fetchModels(config) {
    if (!config) return { success: false, models: [], error: 'config_required' };
    try {
      const authMethod = config.authMethod || 'api_key';
      if (authMethod === 'qoder_local_auth' || authMethod === 'local_cli' || config.channelId === 'qoder') {
        const { models, source, error } = await ops.listQoderModels();
        return { success: true, models, source, ...(error ? { error } : {}) };
      }
      const resolved = ops.resolveChannel({
        channelId: config.channelId,
        wireOverride: config.wireOverride,
        authMethod: 'api_key',
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        customHeaders: config.customHeaders,
      });
      const { models, source } = await ops.listOpenAICompatibleModels({
        baseUrl: resolved.baseUrl,
        headers: resolved.headers,
        wire: resolved.wire,
        apiKey: config.apiKey,
      });
      return { success: true, models, source };
    } catch (error) {
      return { success: false, models: [], error: error?.message || 'models_fetch_failed' };
    }
  }

  return Object.freeze({
    quota: (id, force = false) => ports.fetchQuota(id, Boolean(force)),
    startOAuth,
    openPendingOAuth,
    cancelOAuth() {
      cancelActiveOAuth();
      return { success: true };
    },
    listModels,
    fetchModels,
    dispose: cancelActiveOAuth,
  });
}
