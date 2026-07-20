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
import { createTuiHost } from './tui-host.ts';
import { createTuiProviderFetch } from './provider-transport.ts';
import { createTuiShutdown } from './tui-shutdown.ts';
import { buildTuiSystemPrompt, createTuiLanguageStore } from './tui-language.ts';

// Fast path: `peer --version` / `peer -v` → single line, no TUI boot.
if (handleCliVersionArgs(process.argv.slice(2))) {
  process.exit(0);
}

const providerFetch = createTuiProviderFetch();
const workspaceRoot = process.env.PEER_WORKSPACE_ROOT ?? process.cwd();
const userDataPath = process.env.PEER_USER_DATA_PATH ?? path.join(os.homedir(), '.peer-agent');
const localAccessStore = createTuiLocalAccessStore({ userDataPath });
const languageStore = createTuiLanguageStore({ userDataPath });
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
  if (!metadata) throw new Error(`Provider "${credentialId}" is no longer available.`);

  // ChatGPT subscription and Grok official both speak OpenAI Responses.
  if (metadata.authMethod === 'oauth_chatgpt' || metadata.authMethod === 'oauth_grok') {
    return createChatGptResponsesProvider({
      baseUrl: metadata.baseUrl,
      fetch: providerFetch,
      resolveTokens() {
        const selection = modelConfig.resolveSharedSelection?.(credentialId);
        if (!selection?.oauthTokens) {
          throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
        }
        return selection.oauthTokens;
      },
      async refreshTokens(tokens) {
        if (metadata.authMethod === 'oauth_chatgpt') {
          return refreshChatGptOAuthTokens(tokens);
        }
        // @ts-ignore Desktop ESM adapter without local type declarations.
        const { ensureFreshGrokTokens } = await import('../../desktop/electron/main/llm-oauth/grok-oauth.mjs');
        const fresh = await ensureFreshGrokTokens(tokens, { fetchImpl: providerFetch });
        return fresh.tokens;
      },
      persistTokens(tokens) {
        const selection = modelConfig.resolveSharedSelection?.(credentialId);
        if (!selection) throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
        selection.persistOAuthTokens(tokens);
      },
    });
  }

  // Qoder must reuse Desktop qoder-private (prepareInfer + private SSE), not
  // token + OpenAI-compatible /chat/completions.
  if (metadata.authMethod === 'qoder_local_auth') {
    return createQoderPrivateProvider({
      providerId: credentialId,
      baseUrl: metadata.baseUrl,
      async getAccessToken() {
        // @ts-ignore Desktop ESM adapter without local type declarations.
        const { loadQoderAccessToken } = await import(
          '../../desktop/electron/main/provider-adapters/qoder-local-auth.mjs'
        );
        return loadQoderAccessToken();
      },
    });
  }

  return {
    async stream(request: Parameters<ReturnType<typeof createOpenAICompatibleProvider>['stream']>[0]) {
      const selection = modelConfig.resolveSharedSelection?.(credentialId);
      if (!selection) throw new Error('Desktop credential is locked. Allow Keychain access and retry.');

      let apiKey = selection.apiKey;
      let baseUrl = selection.baseUrl;

      if (selection.authMethod === 'oauth_google') {
        if (!selection.oauthTokens) {
          throw new Error('Desktop Google OAuth tokens are locked. Allow Keychain access and retry.');
        }
        // @ts-ignore Desktop ESM adapter without local type declarations.
        const { ensureFreshGoogleTokens } = await import('../../desktop/electron/main/llm-oauth/google-oauth.mjs');
        const fresh = await ensureFreshGoogleTokens(selection.oauthTokens, { fetchImpl: providerFetch });
        if (fresh.refreshed) selection.persistOAuthTokens(fresh.tokens);
        apiKey = fresh.tokens.access;
        // Prefer Google's OpenAI-compatible gateway so CLI can reuse the shared
        // chat/completions adapter instead of reimplementing Gemini SSE.
        if (baseUrl.includes('generativelanguage.googleapis.com') && !baseUrl.includes('/openai')) {
          baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
        }
      }

      if (!apiKey) throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
      return createOpenAICompatibleProvider({
        config: {
          providerId: credentialId,
          apiKey,
          baseUrl,
        },
        fetch: providerFetch,
      }).stream(request);
    },
  };
}
const provider = sharedMetadata
  ? sharedProvider(sharedMetadata.credentialId)
  : modelConfig.configured
    ? createOpenAICompatibleProvider({
        config: await resolveOpenAICompatibleProviderConfig({
          providerId: 'openai-compatible', credentials: modelConfig.credentials,
        }),
        fetch: providerFetch,
      })
    : null;
const modelSelection = createTuiModelSelectionControl({
  providerId: modelConfig.providerId,
  modelId: modelConfig.model,
  displayName: modelConfig.modelLabel.split(' · ')[0] ?? modelConfig.model,
  reasoningEffort: 'default',
  supportedReasoningEfforts: modelConfig.configured
    ? ['default', 'low', 'high', 'xhigh']
    : ['default'],
  catalog: modelConfig.catalog,
});
const model = provider
  ? createProviderChatModel({
      provider,
      getProvider: () => sharedMetadata
        ? sharedProvider(modelSelection.getSelection().providerId)
        : provider,
      model: modelConfig.model,
      getModel: () => modelSelection.getSelection().modelId,
      getReasoningEffort: () => modelSelection.getSelection().reasoningEffort,
      toolDefinitionsForMode: (mode) => host.toolDefinitionsForMode?.(mode) ?? host.toolDefinitions,
      systemPrompt: buildTuiSystemPrompt(languageStore.getReplyLanguage()),
      getSystemPrompt: () => buildTuiSystemPrompt(languageStore.getReplyLanguage()),
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
    onQuit={shutdown}
  />,
);
