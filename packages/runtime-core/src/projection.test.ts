import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RuntimeProjectionError,
  createRuntimeProjection,
  filterRuntimeToolsForMode,
  isRuntimeToolAvailableInMode,
  materializeAnthropicTools,
  materializeOpenAITools,
  type RuntimeToolDefinition,
} from './index.ts';

function createTool(
  name: string,
  overrides: Partial<RuntimeToolDefinition> = {},
): RuntimeToolDefinition {
  return {
    name,
    capabilityId: `local.${name}`,
    description: `Run ${name}`,
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    },
    ...overrides,
  };
}

test('createRuntimeProjection preserves order and includes all tools without a mode', () => {
  const projection = createRuntimeProjection(
    [
      createTool('default'),
      createTool('plan-only', { modeScopes: ['plan'] }),
    ],
    {
      createdAt: '2026-07-10T00:00:00.000Z',
      metadata: { source: 'test' },
    },
  );

  assert.deepEqual(projection.tools.map((tool) => tool.name), ['default', 'plan-only']);
  assert.equal(projection.createdAt, '2026-07-10T00:00:00.000Z');
  assert.deepEqual(projection.metadata, { source: 'test' });
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.tools), true);

  const nullModeProjection = createRuntimeProjection(
    [createTool('default')],
    { mode: null, createdAt: '2026-07-10T00:00:00.000Z' },
  );
  assert.equal('mode' in nullModeProjection, false);
});

test('mode filtering keeps unscoped tools only in normal user-facing modes', () => {
  const unscoped = createTool('unscoped');
  const planOnly = createTool('plan-only', { modeScopes: ['plan'] });
  const explorerRead = createTool('explorer-read', { modeScopes: ['chat', 'explorer'] });
  const tools = [unscoped, planOnly, explorerRead];

  assert.equal(isRuntimeToolAvailableInMode(unscoped, 'chat'), true);
  assert.equal(isRuntimeToolAvailableInMode(unscoped, 'plan'), true);
  assert.equal(isRuntimeToolAvailableInMode(unscoped, 'goal'), true);
  assert.equal(isRuntimeToolAvailableInMode(unscoped, 'explorer'), false);
  assert.equal(isRuntimeToolAvailableInMode(unscoped, 'compact'), false);
  assert.equal(isRuntimeToolAvailableInMode(unscoped, 'system'), false);
  assert.deepEqual(
    filterRuntimeToolsForMode(tools, 'plan').map((tool) => tool.name),
    ['unscoped', 'plan-only'],
  );
  assert.deepEqual(
    createRuntimeProjection(tools, { mode: 'explorer' }).tools.map((tool) => tool.name),
    ['explorer-read'],
  );
});

test('createRuntimeProjection rejects invalid and duplicate tool definitions', () => {
  assert.throws(
    () => createRuntimeProjection([createTool('duplicate'), createTool('duplicate')]),
    (error) => error instanceof RuntimeProjectionError && error.code === 'duplicate_tool_name',
  );
  assert.throws(
    () => createRuntimeProjection([{ name: 'missing-capability' } as RuntimeToolDefinition]),
    (error) => error instanceof RuntimeProjectionError && error.code === 'invalid_tool_definition',
  );
});

test('provider materializers expose only provider schema fields', () => {
  const projection = createRuntimeProjection([
    createTool('alpha', {
      metadata: {
        permissionPolicy: 'ask',
        executorCapabilityId: 'local.alpha.execute',
      },
    }),
  ]);

  assert.deepEqual(materializeOpenAITools(projection), [{
    type: 'function',
    function: {
      name: 'alpha',
      description: 'Run alpha',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
      },
    },
  }]);
  assert.deepEqual(materializeAnthropicTools(projection), [{
    name: 'alpha',
    description: 'Run alpha',
    input_schema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    },
  }]);
  assert.doesNotMatch(JSON.stringify(materializeOpenAITools(projection)), /permissionPolicy|executorCapabilityId/);
  assert.doesNotMatch(JSON.stringify(materializeAnthropicTools(projection)), /permissionPolicy|executorCapabilityId/);
});

test('provider materializers use stable defaults for optional description and schema', () => {
  const projection = createRuntimeProjection([
    {
      name: 'minimal',
      capabilityId: 'local.minimal',
    },
  ]);

  assert.deepEqual(materializeOpenAITools(projection), [{
    type: 'function',
    function: {
      name: 'minimal',
      description: '',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  }]);
  assert.deepEqual(materializeAnthropicTools(projection), [{
    name: 'minimal',
    description: '',
    input_schema: {
      type: 'object',
      properties: {},
    },
  }]);
});
