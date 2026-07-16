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
import { createTuiHost } from './tui-host.ts';
import { createTuiProviderFetch } from './provider-transport.ts';
import { createTuiShutdown } from './tui-shutdown.ts';

const providerFetch = createTuiProviderFetch();
const workspaceRoot = process.env.PEER_WORKSPACE_ROOT ?? process.cwd();
const userDataPath = process.env.PEER_USER_DATA_PATH ?? path.join(os.homedir(), '.peer-agent');
const localAccessStore = createTuiLocalAccessStore({ userDataPath });
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
  if (metadata.authMethod === 'oauth_chatgpt') {
    return createChatGptResponsesProvider({
      baseUrl: metadata.baseUrl,
      fetch: providerFetch,
      resolveTokens() {
        const selection = modelConfig.resolveSharedSelection?.(credentialId);
        if (!selection?.oauthTokens) throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
        return selection.oauthTokens;
      },
      refreshTokens: refreshChatGptOAuthTokens,
      persistTokens(tokens) {
        const selection = modelConfig.resolveSharedSelection?.(credentialId);
        if (!selection) throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
        selection.persistOAuthTokens(tokens);
      },
    });
  }
  return {
    async stream(request: Parameters<ReturnType<typeof createOpenAICompatibleProvider>['stream']>[0]) {
      const selection = modelConfig.resolveSharedSelection?.(credentialId);
      if (!selection?.apiKey) throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
      return createOpenAICompatibleProvider({
        config: { providerId: credentialId, apiKey: selection.apiKey, baseUrl: selection.baseUrl },
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
      systemPrompt: 'You are Peer Agent. Use the available governed tools when they help answer the user.',
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
    onQuit={shutdown}
  />,
);
