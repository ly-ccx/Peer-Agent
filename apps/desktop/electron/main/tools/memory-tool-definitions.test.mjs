import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { evaluateGoalModeGate } from '../chat-runtime/goal-mode-gate.mjs';
import { createLocalToolHost } from '../runtime-gateway/local-tool-host.mjs';
import { MEMORY_TOOL_DEFINITIONS } from './memory-tool-definitions.mjs';
import {
  createRuntimeProjectionFromToolRegistry,
  createRuntimeToolRegistry,
} from './index.mjs';

test('memory prompts are loaded from resource files and only project_agent can see them', () => {
  for (const tool of MEMORY_TOOL_DEFINITIONS) {
    const asset = readFileSync(
      new URL(`./prompts/memory/${tool.name}.md`, import.meta.url),
      'utf8',
    ).trim();
    assert.equal(tool.prompt(), asset);
    assert.equal(tool.prompt().includes('function '), false);
    assert.deepEqual(tool.availableInModes, ['project_agent']);
  }
  const registry = createRuntimeToolRegistry();
  const projection = createRuntimeProjectionFromToolRegistry(registry, { mode: 'project_agent' });
  const remember = projection.capabilities.find((capability) => capability.name === 'memory_remember');
  assert.equal(remember.health, 'available');
  assert.equal(remember.riskLevel, 'L0_inert');
  assert.deepEqual(
    evaluateGoalModeGate({ mode: 'project_agent', toolName: 'memory_remember', riskLevel: remember.riskLevel }),
    { allowed: true },
  );
  const chat = createRuntimeProjectionFromToolRegistry(registry, { mode: 'chat' });
  assert.equal(
    chat.capabilities.find((capability) => capability.name === 'memory_remember')?.health,
    'mode_excluded',
  );
});

test('the default local tool host registers every memory capability', () => {
  const host = createLocalToolHost({
    workspaceRoot: '/tmp/peer-memory',
    userDataPath: '/tmp/peer-memory',
    sessionStore: { getSession() { return null; } },
  });
  const ids = host.providerRegistry.listCapabilityIds();
  for (const tool of MEMORY_TOOL_DEFINITIONS) {
    assert.equal(ids.includes(tool.runtime.executorCapabilityId), true);
  }
});
