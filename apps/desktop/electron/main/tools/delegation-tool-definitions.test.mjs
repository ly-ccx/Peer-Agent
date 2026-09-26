import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { evaluateGoalModeGate } from '../chat-runtime/goal-mode-gate.mjs';
import { createLocalToolHost } from '../runtime-gateway/local-tool-host.mjs';
import { DELEGATION_TOOL_DEFINITIONS } from './delegation-tool-definitions.mjs';
import {
  createRuntimeProjectionFromToolRegistry,
  createRuntimeToolRegistry,
} from './index.mjs';

test('delegation prompts are loaded from resource files and only project_agent can see them', () => {
  for (const tool of DELEGATION_TOOL_DEFINITIONS) {
    const asset = readFileSync(
      new URL(`./prompts/delegation/${tool.name}.md`, import.meta.url),
      'utf8',
    ).trim();
    assert.equal(tool.prompt(), asset);
    assert.equal(tool.prompt().includes('function '), false);
    assert.deepEqual(tool.availableInModes, ['project_agent']);
  }
  const registry = createRuntimeToolRegistry();
  const projection = createRuntimeProjectionFromToolRegistry(registry, { mode: 'project_agent' });
  const spawn = projection.capabilities.find((capability) => capability.name === 'spawn_session');
  assert.equal(spawn.health, 'available');
  assert.equal(spawn.riskLevel, 'L0_inert');
  assert.deepEqual(
    evaluateGoalModeGate({ mode: 'project_agent', toolName: 'spawn_session', riskLevel: spawn.riskLevel }),
    { allowed: true },
  );
  const chat = createRuntimeProjectionFromToolRegistry(registry, { mode: 'chat' });
  assert.equal(
    chat.capabilities.find((capability) => capability.name === 'spawn_session')?.health,
    'mode_excluded',
  );
});

test('the default local tool host registers every delegation capability', () => {
  const host = createLocalToolHost({
    workspaceRoot: '/tmp/peer-delegation',
    userDataPath: '/tmp/peer-delegation',
    sessionStore: { getSession() { return null; } },
  });
  const ids = host.providerRegistry.listCapabilityIds();
  for (const tool of DELEGATION_TOOL_DEFINITIONS) {
    assert.equal(ids.includes(tool.runtime.executorCapabilityId), true);
  }
});
