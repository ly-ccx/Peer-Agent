import { readFileSync } from 'node:fs';

import { DELEGATION_TOOL_SPECS } from '@peer-agent/runtime-node';

const promptAssetCache = new Map();

function readPromptAsset(filename) {
  if (!promptAssetCache.has(filename)) {
    promptAssetCache.set(
      filename,
      readFileSync(new URL(`./prompts/delegation/${filename}`, import.meta.url), 'utf8').trim(),
    );
  }
  return promptAssetCache.get(filename);
}

const DELEGATION_RUNTIME = Object.freeze({
  adapter: 'runtime-gateway.local-delegation-provider',
});

export const DELEGATION_TOOL_DEFINITIONS = DELEGATION_TOOL_SPECS.map((item) => ({
  name: item.name,
  capabilityId: item.capabilityId,
  availableInModes: ['project_agent'],
  prompt: () => readPromptAsset(`${item.name}.md`),
  runtime: Object.freeze({
    ...DELEGATION_RUNTIME,
    executorCapabilityId: item.capabilityId,
  }),
  permissionPolicy: {
    kind: item.name === 'list_sessions' || item.name === 'get_session' ? 'goal-read' : 'goal-create',
  },
  inputSchema: item.inputSchema,
}));
