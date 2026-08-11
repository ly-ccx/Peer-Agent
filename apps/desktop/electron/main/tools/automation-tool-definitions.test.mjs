import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeToolRegistry } from './index.mjs';
import {
  createModelToolProjectionFromRuntimeProjection,
  createRuntimeProjectionFromToolRegistry,
} from './runtime-projection-tool-materializer.mjs';

const TOOL_NAME = 'propose_automation_task';
const CAPABILITY_ID = 'local.automation.propose';

test('automation proposal tool is registered and projected through the local capability', () => {
  const registry = createRuntimeToolRegistry();
  const tool = registry.getTool(TOOL_NAME);
  assert.ok(tool);
  assert.equal(tool.runtime.executorCapabilityId, CAPABILITY_ID);
  assert.deepEqual(tool.availableInModes, ['chat']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ['name', 'prompt', 'schedule', 'confidence']);

  const projection = createRuntimeProjectionFromToolRegistry(registry, {
    mode: 'chat',
    workspacePath: '/workspace',
  });
  const capability = projection.capabilities.find((entry) => entry.capabilityId === CAPABILITY_ID);
  assert.ok(capability);
  assert.equal(capability.name, TOOL_NAME);
  assert.equal(capability.health, 'available');
  assert.equal(capability.riskLevel, 'L2_local_write');
  assert.equal(capability.dataLevel, 'D2_sensitive');
  assert.deepEqual(capability.evidencePolicy, {
    returnMode: 'summary',
    maxChars: 4_000,
    redactSensitive: false,
  });
});

test('automation proposal tool is excluded from the model projection outside chat mode', () => {
  const registry = createRuntimeToolRegistry();
  const runtimeProjection = createRuntimeProjectionFromToolRegistry(registry, {
    mode: 'goal',
    workspacePath: '/workspace',
  });
  const capability = runtimeProjection.capabilities.find(
    (entry) => entry.capabilityId === CAPABILITY_ID,
  );
  assert.equal(capability?.health, 'mode_excluded');

  const modelProjection = createModelToolProjectionFromRuntimeProjection(
    runtimeProjection,
    registry,
    { mode: 'goal' },
  );
  assert.equal(modelProjection.tools.some((entry) => entry.name === TOOL_NAME), false);
});
