import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeToolRegistry } from './index.mjs';
import {
  BROWSER_CAPABILITY_TO_TOOL,
  BROWSER_TOOL_NAMES,
} from './browser-tool-definitions.mjs';
import { createRuntimeProjectionFromToolRegistry } from './runtime-projection-tool-materializer.mjs';

test('browser_open_panel is registered and projected through the local Browser capability', () => {
  const registry = createRuntimeToolRegistry();
  const tool = registry.getTool('browser_open_panel');
  assert.ok(tool);
  assert.equal(BROWSER_TOOL_NAMES.openPanel, 'browser_open_panel');
  assert.equal(
    BROWSER_CAPABILITY_TO_TOOL['local.web.control.openPanel'],
    'browser_open_panel',
  );
  assert.equal(tool.capabilityId, 'local.web.control.openPanel');
  assert.equal(tool.runtime.executorCapabilityId, 'local.web.control.openPanel');
  assert.deepEqual(tool.availableInModes, ['chat', 'goal']);
  assert.match(tool.prompt(), /idempotent/i);

  const projection = createRuntimeProjectionFromToolRegistry(registry, {
    mode: 'chat',
    workspacePath: '/tmp/peer-agent-browser-open-panel-test',
  });
  const capability = projection.capabilities.find(
    (entry) => entry.capabilityId === 'local.web.control.openPanel',
  );
  assert.ok(capability);
  assert.equal(capability.riskLevel, 'L1_local_read');
  assert.equal(capability.dataLevel, 'D1_internal');
  assert.deepEqual(capability.evidencePolicy, {
    returnMode: 'summary',
    maxChars: 4000,
    redactSensitive: false,
  });
});
