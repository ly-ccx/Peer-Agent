import { readFileSync } from 'node:fs';

import { MEMORY_TOOL_SPECS } from '@peer-agent/runtime-node';

const promptAssetCache = new Map();

function readPromptAsset(filename) {
  if (!promptAssetCache.has(filename)) {
    promptAssetCache.set(
      filename,
      readFileSync(new URL(`./prompts/memory/${filename}`, import.meta.url), 'utf8').trim(),
    );
  }
  return promptAssetCache.get(filename);
}

const MEMORY_RUNTIME = Object.freeze({
  adapter: 'runtime-gateway.local-memory-provider',
});

const READ_TOOLS = new Set(['memory_search']);

export const MEMORY_TOOL_DEFINITIONS = MEMORY_TOOL_SPECS.map((item) => ({
  name: item.name,
  capabilityId: item.capabilityId,
  availableInModes: ['project_agent'],
  prompt: () => readPromptAsset(`${item.name}.md`),
  runtime: Object.freeze({
    ...MEMORY_RUNTIME,
    executorCapabilityId: item.capabilityId,
  }),
  permissionPolicy: {
    kind: READ_TOOLS.has(item.name) ? 'goal-read' : 'goal-create',
  },
  inputSchema: item.inputSchema,
}));
