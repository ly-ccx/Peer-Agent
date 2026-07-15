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
import {
  createProviderChatModel,
  createUnavailableChatModel,
} from './provider-chat-model.ts';
import { createTuiHost } from './tui-host.ts';

const workspaceRoot = process.env.PEER_WORKSPACE_ROOT ?? process.cwd();
const userDataPath = process.env.PEER_USER_DATA_PATH ?? path.join(os.homedir(), '.peer-agent');
const host = createTuiHost({ workspaceRoot, userDataPath });
const modelConfig = resolveTuiModelConfig(process.env, { userDataPath });
const sharedMetadata = modelConfig.sharedMetadata;
const provider = sharedMetadata?.authMethod === 'oauth_chatgpt'
  ? createChatGptResponsesProvider({
      baseUrl: sharedMetadata.baseUrl,
      resolveTokens() {
        const selection = modelConfig.resolveSharedSelection?.();
        if (!selection?.oauthTokens) throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
        return selection.oauthTokens;
      },
      refreshTokens: refreshChatGptOAuthTokens,
      persistTokens(tokens) {
        const selection = modelConfig.resolveSharedSelection?.();
        if (!selection) throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
        selection.persistOAuthTokens(tokens);
      },
    })
  : sharedMetadata?.authMethod === 'api_key'
    ? {
        async stream(request: Parameters<ReturnType<typeof createOpenAICompatibleProvider>['stream']>[0]) {
          const selection = modelConfig.resolveSharedSelection?.();
          if (!selection?.apiKey) throw new Error('Desktop credential is locked. Allow Keychain access and retry.');
          return createOpenAICompatibleProvider({
            config: {
              providerId: 'openai-compatible',
              apiKey: selection.apiKey,
              baseUrl: selection.baseUrl,
            },
          }).stream(request);
        },
      }
    : modelConfig.configured
      ? createOpenAICompatibleProvider({
          config: await resolveOpenAICompatibleProviderConfig({
            providerId: 'openai-compatible',
            credentials: modelConfig.credentials,
          }),
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
});
const model = provider
  ? createProviderChatModel({
      provider,
      model: modelConfig.model,
      getModel: () => modelSelection.getSelection().modelId,
      getReasoningEffort: () => modelSelection.getSelection().reasoningEffort,
      toolDefinitionsForMode: (mode) => host.toolDefinitionsForMode?.(mode) ?? host.toolDefinitions,
      systemPrompt: 'You are Peer Agent. Use the available governed tools when they help answer the user.',
    })
  : createUnavailableChatModel(missingModelConfigurationMessage());
const renderer = await createCliRenderer({ exitOnCtrlC: false });

createRoot(renderer).render(
  <App
    host={host}
    model={model}
    modelLabel={modelConfig.modelLabel}
    modelSelection={modelSelection}
  />,
);
