#!/usr/bin/env bun

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import os from 'node:os';
import path from 'node:path';
import {
  createChatGptResponsesProvider,
  createOpenAICompatibleProvider,
  refreshChatGptOAuthTokens,
  resolveOpenAICompatibleProviderConfig,
} from '@peer-agent/runtime-node';

import { App } from './app.tsx';
import { handleCliVersionArgs } from './cli-version.ts';
import {
  missingModelConfigurationMessage,
  resolveTuiModelConfig,
} from './model-config.ts';
import { createTuiModelSelectionControl } from './tui-model-selection.ts';
import { createTuiLocalAccessStore } from './tui-local-access-store.ts';
import {
  createProviderChatModel,
  createUnavailableChatModel,
} from './provider-chat-model.ts';
import { createQoderPrivateProvider } from './qoder-private-provider.ts';
import { createAnthropicMessagesProvider } from './anthropic-messages-provider.ts';
import { createGeminiProvider } from './gemini-provider.ts';
import { resolveTuiWire } from './provider-wire-matrix.ts';
import {
  ensureFreshGoogleTokensFromDesktop,
  ensureFreshGrokTokensFromDesktop,
  loadQoderAccessTokenFromDesktop,
} from './desktop-provider-adapters.ts';
import { createTuiHost } from './tui-host.ts';
import { createTuiProviderFetch } from './provider-transport.ts';
import { createTuiShutdown } from './tui-shutdown.ts';
import { buildTuiSystemPrompt, createTuiLanguageStore } from './tui-language.ts';
import { createTuiThemeStore } from './tui-theme.ts';

// Fast path: `peer --version` / `peer -v` → single line, no TUI boot.
if (handleCliVersionArgs(process.argv.slice(2))) {
  process.exit(0);
}

const providerFetch = createTuiProviderFetch();
const workspaceRoot = process.env.PEER_WORKSPACE_ROOT ?? process.cwd();
const userDataPath = process.env.PEER_USER_DATA_PATH ?? path.join(os.homedir(), '.peer-agent');
const localAccessStore = createTuiLocalAccessStore({ userDataPath });
const languageStore = createTuiLanguageStore({ userDataPath });
const themeStore = createTuiThemeStore({ userDataPath });
const host = createTuiHost({
  workspaceRoot,
  userDataPath,
  accessLevel: localAccessStore.getAccessLevel(),
  persistAccessLevel: (accessLevel) => localAccessStore.setAccessLevel(accessLevel),
});
const modelConfig = resolveTuiModelConfig(process.env, { userDataPath });
const sharedMetadata = modelConfig.sharedMetadata;
function sharedProvider(credentialId: string) {
  const metadata = modelConfig.sharedProviders?.find((item) => item.credentialId === credentialId);
  if (!metadata) throw new Error(`Provider credential not found: ${credentialId}`);

  return {
    async stream(request: Parameters<NonNullable<typeof host.chatModel>['stream']>[0]) {
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
            const fresh = await ensureFreshGrokTokensFromDesktop(tokens, { fetchImpl: providerFetch });
            return fresh.tokens;
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
const systemPrompt = () => buildTuiSystemPrompt(
  languageStore.getReplyLanguage(),
  [host.skillMcpBridge?.discoveryHint() ?? ''],
);
const model = provider
  ? createProviderChatModel({
      provider,
      getProvider: () => sharedMetadata
        ? sharedProvider(modelSelection.getSelection().providerId)
        : provider,
      model: modelConfig.model,
      getModel: () => modelSelection.getSelection().modelId,
      getReasoningEffort: () => modelSelection.getSelection().reasoningEffort,
      getContextWindow: () => {
        const selection = modelSelection.getSelection();
        return modelSelection.catalog.find((entry) => (
          entry.providerId === selection.providerId && entry.modelId === selection.modelId
        ))?.contextWindow;
      },
      toolDefinitionsForMode: (mode) => host.toolDefinitionsForMode?.(mode) ?? host.toolDefinitions,
      systemPrompt: systemPrompt(),
      getSystemPrompt: systemPrompt,
    })
  : createUnavailableChatModel(missingModelConfigurationMessage());
const renderer = await createCliRenderer({ exitOnCtrlC: false });
const root = createRoot(renderer);
const shutdown = createTuiShutdown({
  unmount: () => root.unmount(),
  destroyRenderer: () => renderer.destroy(),
  exitProcess: (code) => process.exit(code),
});

root.render(
  <App
    host={host}
    model={model}
    modelLabel={modelConfig.modelLabel}
    modelSelection={modelSelection}
    languageStore={languageStore}
    themeStore={themeStore}
    onQuit={shutdown}
  />,
);
