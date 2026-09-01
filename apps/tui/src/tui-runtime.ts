import { contextAccountingModelKey, type LocalAccessLevel } from '@peer-agent/protocol';
import {
  createChatGptResponsesProvider,
  createOpenAICompatibleProvider,
  effectiveFastMode,
  refreshChatGptOAuthTokens,
  type ModelProviderRequest,
} from '@peer-agent/runtime-node';

import {
  missingModelConfigurationMessage,
  resolveTuiModelConfig,
  type TuiModelConfig,
} from './model-config.ts';
import { createTuiModelSelectionControl, type TuiModelSelectionControl } from './tui-model-selection.ts';
import {
  createProviderChatModel,
  createUnavailableChatModel,
  type ProviderSystemPromptContext,
} from './provider-chat-model.ts';
import { createQoderPrivateProvider } from './qoder-private-provider.ts';
import { createAnthropicMessagesProvider } from './anthropic-messages-provider.ts';
import { createGeminiProvider } from './gemini-provider.ts';
import { resolveTuiWire } from './provider-wire-matrix.ts';
import {
  ensureFreshGoogleTokensFromDesktop,
  ensureFreshGrokTokensFromDesktop,
  startGrokReLoginFromDesktop,
  loadQoderAccessTokenFromDesktop,
} from './desktop-provider-adapters.ts';
import { denyInteractiveTools, restrictTuiHostTools } from './cli-host-filter.ts';
import { createTuiHost, type TuiHost } from './tui-host.ts';
import { createTuiProviderFetch } from './provider-transport.ts';
import { buildTuiSystemPrompt, createTuiLanguageStore, type TuiLanguageStore } from './tui-language.ts';
import { createTuiThemeStore, type TuiThemeStore } from './tui-theme.ts';
import type { ChatModelPort } from './chat-controller.ts';

export interface CreateTuiRuntimeOptions {
  readonly workspaceRoot: string;
  readonly userDataPath: string;
  readonly accessLevel: LocalAccessLevel;
  readonly persistAccessLevel?: (accessLevel: LocalAccessLevel) => void;
  readonly toolAllowlist?: readonly string[];
  readonly denyInteractiveTools?: boolean;
  readonly initialFastMode?: boolean;
}

export interface TuiRuntime {
  readonly host: TuiHost;
  readonly model: ChatModelPort;
  readonly modelSelection: TuiModelSelectionControl;
  readonly modelConfig: TuiModelConfig;
  readonly languageStore: TuiLanguageStore;
  readonly themeStore: TuiThemeStore;
  getSessionFastMode(): boolean;
  setSessionFastMode(fastMode: boolean): void;
  dispose(): Promise<void>;
}

export function createTuiRuntime(options: CreateTuiRuntimeOptions): TuiRuntime {
  const { workspaceRoot, userDataPath } = options;
  const providerFetch = createTuiProviderFetch();
  const languageStore = createTuiLanguageStore({ userDataPath });
  const themeStore = createTuiThemeStore({ userDataPath });
  let host = createTuiHost({
    workspaceRoot,
    userDataPath,
    accessLevel: options.accessLevel,
    persistAccessLevel: options.persistAccessLevel,
  });
  if (options.toolAllowlist) {
    host = restrictTuiHostTools(host, options.toolAllowlist);
  }
  if (options.denyInteractiveTools) {
    host = denyInteractiveTools(host);
  }
  const modelConfig = resolveTuiModelConfig(process.env, { userDataPath });
  const sharedMetadata = modelConfig.sharedMetadata;
  let sessionFastMode = options.initialFastMode === true;

  function authMethodFor(credentialId: string | undefined): string | null {
    if (!credentialId) return modelConfig.sharedMetadata?.authMethod ?? null;
    return modelConfig.sharedProviders?.find((item) => item.credentialId === credentialId)?.authMethod
      ?? (modelConfig.sharedMetadata?.credentialId === credentialId
        ? modelConfig.sharedMetadata.authMethod
        : null);
  }
  function sharedProvider(credentialId: string) {
    const metadata = modelConfig.sharedProviders?.find((item) => item.credentialId === credentialId);
    if (!metadata) throw new Error(`Provider credential not found: ${credentialId}`);

    return {
      async stream(request: ModelProviderRequest) {
        const selection = modelConfig.resolveSharedSelection?.(credentialId);
        if (!selection) {
          throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
        }

        const decision = resolveTuiWire({
          channelId: metadata.channelId,
          authMethod: metadata.authMethod,
          providerId: metadata.providerId,
          displayName: metadata.displayName,
        });
        if (decision.kind === 'unsupported') {
          throw new Error(decision.reason);
        }

        // ChatGPT / Grok OAuth use OpenAI Responses.
        if (decision.wire === 'openai-responses') {
          return createChatGptResponsesProvider({
            baseUrl: metadata.baseUrl,
            fetch: providerFetch,
            // Match desktop provider-channels Grok identity so CLI does not hit HTTP 426
            // "Grok CLI version (none) is outdated" without requiring a local grok CLI.
            ...(metadata.authMethod === 'oauth_grok'
              ? {
                  extraHeaders: {
                    'X-XAI-Token-Auth': 'xai-grok-cli',
                    'x-grok-client-surface': 'grok-build',
                    'x-grok-client-version': '0.1.202',
                  },
                }
              : {}),
            resolveTokens() {
              const current = modelConfig.resolveSharedSelection?.(credentialId);
              if (!current?.oauthTokens) {
                throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
              }
              return current.oauthTokens;
            },
            async refreshTokens(tokens) {
              if (metadata.authMethod === 'oauth_chatgpt') {
                return refreshChatGptOAuthTokens(tokens);
              }
              try {
                const fresh = await ensureFreshGrokTokensFromDesktop(tokens, { fetchImpl: providerFetch });
                return fresh.tokens;
              } catch (err: any) {
                if (err?.code === 'grok_oauth_scope_upgrade_required') {
                  // Scope upgrade requires a fresh device flow — refresh tokens
                  // cannot add `api:access`. Auto-trigger re-login in the CLI.
                  const reLoginTokens = await startGrokReLoginFromDesktop({ fetchImpl: providerFetch });
                  // Persist the new tokens so subsequent requests don't re-trigger.
                  const current = modelConfig.resolveSharedSelection?.(credentialId);
                  if (current) current.persistOAuthTokens(reLoginTokens);
                  return reLoginTokens;
                }
                throw err;
              }
            },
            persistTokens(tokens) {
              const current = modelConfig.resolveSharedSelection?.(credentialId);
              if (!current) throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
              current.persistOAuthTokens(tokens);
            },
          }).stream(request);
        }

        // Qoder private SSE wire (not OpenAI-compatible chat/completions).
        if (decision.wire === 'qoder-private') {
          return createQoderPrivateProvider({
            providerId: credentialId,
            baseUrl: metadata.baseUrl,
            async getAccessToken() {
              const current = modelConfig.resolveSharedSelection?.(credentialId);
              if (current?.apiKey) return current.apiKey;
              return loadQoderAccessTokenFromDesktop();
            },
          }).stream(request);
        }

        // Anthropic Messages API (/v1/messages), not OpenAI-compatible chat/completions.
        if (decision.wire === 'anthropic-messages') {
          return createAnthropicMessagesProvider({
            providerId: credentialId,
            baseUrl: metadata.baseUrl,
            async getApiKey() {
              const current = modelConfig.resolveSharedSelection?.(credentialId);
              if (!current?.apiKey) {
                throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
              }
              return current.apiKey;
            },
          }).stream(request);
        }

        // Gemini generateContent SSE (Code Assist for OAuth; never .../v1beta/openai).
        if (decision.wire === 'gemini') {
          return createGeminiProvider({
            providerId: credentialId,
            baseUrl: metadata.baseUrl,
            authMethod: metadata.authMethod || decision.authMethod || 'api_key',
            async getApiKey() {
              const current = modelConfig.resolveSharedSelection?.(credentialId);
              if (current?.apiKey) return current.apiKey;
              if (metadata.authMethod === 'oauth_google' && current?.oauthTokens) {
                const fresh = await ensureFreshGoogleTokensFromDesktop(current.oauthTokens);
                if (fresh?.access) {
                  current.persistOAuthTokens?.(fresh);
                  return String(fresh.access);
                }
              }
              throw new Error(
                metadata.authMethod === 'oauth_google'
                  ? 'Google OAuth access token is unavailable. Sign in via Desktop or unlock Keychain and retry.'
                  : 'Desktop credential is locked. Allow Keychain access and retry.',
              );
            },
            async getProjectId() {
              const current = modelConfig.resolveSharedSelection?.(credentialId);
              const tokens = current?.oauthTokens as { projectId?: string; project_id?: string } | undefined;
              return tokens?.projectId || tokens?.project_id || null;
            },
          }).stream(request);
        }

        // True OpenAI-compatible chat/completions only.
        if (decision.wire === 'openai-chat') {
          const current = modelConfig.resolveSharedSelection?.(credentialId);
          const apiKey = current?.apiKey;
          if (!apiKey) throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
          return createOpenAICompatibleProvider({
            config: {
              providerId: credentialId,
              apiKey,
              baseUrl: metadata.baseUrl,
            },
            fetch: providerFetch,
          }).stream(request);
        }

        throw new Error(
          `TUI has no provider constructor for wire "${decision.wire}" `
          + `(channel=${decision.channelId}, auth=${decision.authMethod}).`,
        );
      },
    };
  }

  // Seed the chat model with the selected Desktop-projected provider. Later model
  // switches resolve through the same sharedProvider seam in getProvider below.
  // Environment credentials (PEER_MODEL_API_KEY, the keychain-less CLI path) build
  // an openai-compatible provider directly from the env source.
  const environmentSelection = modelConfig.source === 'environment'
    ? modelConfig.credentials?.environmentCredential?.('openai-compatible')
    : null;
  const provider = sharedMetadata
    ? sharedProvider(modelConfig.providerId)
    : environmentSelection
      ? createOpenAICompatibleProvider({
        config: {
          providerId: 'openai-compatible',
          apiKey: environmentSelection.apiKey,
          baseUrl: environmentSelection.baseUrl ?? 'https://api.openai.com/v1',
        },
        fetch: providerFetch,
      })
      : undefined;

  const preferredCatalogEntry = modelConfig.catalog.find((entry) => (
    entry.providerId === modelConfig.providerId
    && entry.modelId === modelConfig.model
    && entry.available
  )) ?? modelConfig.catalog.find((entry) => entry.available);
  const modelSelection = createTuiModelSelectionControl({
    providerId: modelConfig.providerId,
    modelId: modelConfig.model,
    displayName: modelConfig.modelLabel.split(' · ')[0] ?? modelConfig.model,
    // Use Desktop-projected default/levels from catalog (not a TUI hardcode).
    reasoningEffort: preferredCatalogEntry?.defaultReasoningEffort ?? 'default',
    supportedReasoningEfforts: preferredCatalogEntry?.supportedReasoningEfforts
      ?? (modelConfig.configured ? ['off', 'low', 'default', 'high'] : ['default']),
    catalog: modelConfig.catalog,
  });
  const systemPrompt = (context: ProviderSystemPromptContext) => {
    const selection = modelSelection.getSelection();
    const providerMetadata = modelConfig.sharedProviders?.find(
      (item) => item.credentialId === selection.providerId,
    );
    return buildTuiSystemPrompt(
      languageStore.getPromptSettings(),
      {
        ...(context.systemContextInput ?? {}),
        workspacePath: workspaceRoot,
        provider: providerMetadata?.channelId ?? selection.providerId,
        model: selection.modelId,
        effort: selection.reasoningEffort,
        mode: context.mode,
        conversationId: context.conversationId ?? null,
        goalPlanStore: host.goalBridge?.store,
        mcpRegistry: host.skillMcpBridge?.mcpRegistry,
        continuityContext: [
          ...(Array.isArray(context.systemContextInput?.continuityContext)
            ? context.systemContextInput.continuityContext
            : []),
          ...(context.systemContextBlocks?.map((block) => ({
            id: block.id,
            method: 'tui',
            content: block.content,
          })) ?? []),
        ],
      },
    );
  };
  const model = provider
    ? createProviderChatModel({
        provider,
        getProvider: () => sharedMetadata
          ? sharedProvider(modelSelection.getSelection().providerId)
          : provider,
        model: modelConfig.model,
        getModel: () => modelSelection.getSelection().modelId,
        getModelKey: () => {
          const selection = modelSelection.getSelection();
          return contextAccountingModelKey(selection.providerId, selection.modelId);
        },
        getReasoningEffort: () => modelSelection.getSelection().reasoningEffort,
        getFastMode: () => effectiveFastMode(
          authMethodFor(modelSelection.getSelection().providerId),
          sessionFastMode,
        ),
        getContextWindow: () => {
          const selection = modelSelection.getSelection();
          return modelSelection.catalog.find((entry) => (
            entry.providerId === selection.providerId && entry.modelId === selection.modelId
          ))?.contextWindow;
        },
        toolDefinitionsForMode: (mode) => host.toolDefinitionsForMode?.(mode) ?? host.toolDefinitions,
        getSystemPrompt: systemPrompt,
      })
    : createUnavailableChatModel(missingModelConfigurationMessage());

  return {
    host,
    model,
    modelSelection,
    modelConfig,
    languageStore,
    themeStore,
    getSessionFastMode: () => sessionFastMode,
    setSessionFastMode(fastMode) {
      sessionFastMode = fastMode === true;
    },
    dispose: () => host.dispose(),
  };
}
