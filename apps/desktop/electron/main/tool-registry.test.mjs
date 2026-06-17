import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAnthropicTools,
  buildOpenAITools,
  buildOpenAIToolsFromRuntimeProjection,
  buildOpenAIToolsFromRegistry,
  createRuntimeProjectionFromToolRegistry,
  createRuntimeToolRegistry,
  createToolRegistry,
  getToolDefinition,
  listToolDefinitions,
  TOOL_NAMES,
} from './tools/index.mjs';

function makeTool(name) {
  return {
    name,
    capabilityId: `test.${name}`,
    prompt: () => `Prompt for ${name}`,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  };
}

describe('Tool Registry', () => {
  it('lists default legacy local tool definitions with migration metadata', () => {
    const names = listToolDefinitions().map((tool) => tool.name);

    assert.deepEqual(names, [
      TOOL_NAMES.bash,
      TOOL_NAMES.readFile,
      TOOL_NAMES.editFile,
      TOOL_NAMES.writeFile,
    ]);

    const editTool = getToolDefinition(TOOL_NAMES.editFile);
    assert.equal(editTool.capabilityId, 'legacy.local.file.edit');
    assert.equal(editTool.runtime.adapter, 'runtime-gateway.legacy-llm-local-tool-provider');
    assert.equal(editTool.runtime.migrationTarget, 'runtime-gateway.local-tool-host');
    assert.equal(editTool.runtime.executorCapabilityId, 'local.file.edit');
    assert.equal(editTool.permissionPolicy.requiresFreshRead, true);
  });

  it('rejects duplicate tool names', () => {
    assert.throws(
      () => createToolRegistry({
        tools: [
          makeTool('dup'),
          makeTool('dup'),
        ],
      }),
      /Duplicate tool definition: dup/,
    );
  });

  it('materializes provider tool schemas from registry definitions', () => {
    const registry = createToolRegistry({
      tools: [
        makeTool('alpha'),
      ],
    });

    assert.deepEqual(buildOpenAIToolsFromRegistry(registry), [{
      type: 'function',
      function: {
        name: 'alpha',
        description: 'Prompt for alpha',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    }]);
  });

  it('keeps internal runtime metadata out of provider tool schemas', () => {
    const openAiTools = buildOpenAITools();
    const anthropicTools = buildAnthropicTools();
    const openAiSerialized = JSON.stringify(openAiTools);
    const anthropicSerialized = JSON.stringify(anthropicTools);

    assert.match(openAiSerialized, /read_file/);
    assert.match(anthropicSerialized, /read_file/);
    assert.doesNotMatch(openAiSerialized, /runtime-gateway\.legacy-llm-local-tool-provider/);
    assert.doesNotMatch(anthropicSerialized, /runtime-gateway\.legacy-llm-local-tool-provider/);
    assert.doesNotMatch(openAiSerialized, /permissionPolicy/);
    assert.doesNotMatch(anthropicSerialized, /permissionPolicy/);
  });

  it('loads default tool prompts from prompt asset files', () => {
    const bashTool = getToolDefinition(TOOL_NAMES.bash);
    const readTool = getToolDefinition(TOOL_NAMES.readFile);

    assert.match(bashTool.prompt(), /Use read_file instead of bash cat/);
    assert.match(readTool.prompt(), /Use bash for broad search/);
  });

  it('creates Runtime Projection manifests with formal executor capabilities', () => {
    const projection = createRuntimeProjectionFromToolRegistry(createToolRegistry({
      tools: [
        makeTool('alpha'),
        {
          ...makeTool('read_file'),
          runtime: { executorCapabilityId: 'local.file.read' },
          permissionPolicy: { kind: 'file-read' },
        },
      ],
    }), {
      projectionId: 'p1',
      sessionId: 's1',
      createdAt: '2026-06-10T00:00:00.000Z',
    });

    assert.equal(projection.projectionId, 'p1');
    assert.equal(projection.sessionId, 's1');
    assert.equal(projection.capabilities.length, 2);
    assert.equal(projection.capabilities[0].capabilityId, 'test.alpha');
    assert.equal(projection.capabilities[1].capabilityId, 'local.file.read');
    assert.equal(projection.capabilities[1].source, 'native');
    assert.equal(projection.capabilities[1].riskLevel, 'L1_local_read');
  });

  it('materializes provider tools from Runtime Projection availability', () => {
    const registry = createToolRegistry({
      tools: [
        {
          ...makeTool('bash'),
          runtime: { executorCapabilityId: 'local.shell.exec' },
          permissionPolicy: { kind: 'shell' },
        },
        {
          ...makeTool('write_file'),
          runtime: { executorCapabilityId: 'local.file.write' },
          permissionPolicy: { kind: 'file-write' },
        },
      ],
    });
    const projection = createRuntimeProjectionFromToolRegistry(registry);
    const [shellCapability, fileCapability] = projection.capabilities;
    const limitedProjection = {
      ...projection,
      capabilities: [
        shellCapability,
        { ...fileCapability, health: 'policy_disabled' },
      ],
    };

    const openAiTools = buildOpenAIToolsFromRuntimeProjection(limitedProjection, registry);

    assert.deepEqual(openAiTools.map((tool) => tool.function.name), ['bash']);
  });
});

describe('Goal mode runtime tool exposure', () => {
  it('exposes goal_update_task through the runtime tool registry and projection', () => {
    const registry = createRuntimeToolRegistry();
    const goalTool = registry.getTool('goal_update_task');
    assert.ok(goalTool, 'goal_update_task should be registered in the runtime tool registry');
    assert.equal(goalTool.runtime.executorCapabilityId, 'local.goal.update');

    const projection = createRuntimeProjectionFromToolRegistry(registry);
    const goalCapability = projection.capabilities.find(
      (cap) => cap.capabilityId === 'local.goal.update',
    );
    assert.ok(goalCapability, 'local.goal.update should appear in the runtime projection');

    const openAiTools = buildOpenAIToolsFromRuntimeProjection(projection, registry);
    const names = openAiTools.map((tool) => tool.function.name);
    assert.ok(
      names.includes('goal_update_task'),
      'goal_update_task should be materialized as a provider tool',
    );
  });
});
