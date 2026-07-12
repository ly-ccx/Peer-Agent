#!/usr/bin/env bun

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import {
  createOpenAICompatibleProvider,
  resolveOpenAICompatibleProviderConfig,
} from '@peer-agent/runtime-node';

import { App } from './app.tsx';
import {
  missingModelConfigurationMessage,
  resolveTuiModelConfig,
} from './model-config.ts';
import {
  createProviderChatModel,
  createUnavailableChatModel,
} from './provider-chat-model.ts';
import { createTuiHost } from './tui-host.ts';

const workspaceRoot = process.env.PEER_WORKSPACE_ROOT ?? process.cwd();
const host = createTuiHost(workspaceRoot);
const modelConfig = resolveTuiModelConfig(process.env);
const model = modelConfig.configured
  ? createProviderChatModel({
      provider: createOpenAICompatibleProvider({
        config: await resolveOpenAICompatibleProviderConfig({
          providerId: modelConfig.providerId,
          credentials: modelConfig.credentials,
        }),
      }),
      model: modelConfig.model,
      toolDefinitions: host.toolDefinitions,
      systemPrompt: 'You are Peer Agent. Use the available governed tools when they help answer the user.',
    })
  : createUnavailableChatModel(missingModelConfigurationMessage());
const renderer = await createCliRenderer({ exitOnCtrlC: false });

createRoot(renderer).render(
  <App
    host={host}
    model={model}
    modelLabel={modelConfig.configured ? modelConfig.model : 'model not configured'}
  />,
);
