import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeToolRegistry } from './index.mjs';
import {
  BROWSER_CAPABILITY_TO_TOOL,
  BROWSER_TOOL_NAMES,
} from './browser-tool-definitions.mjs';
import {
  EXTERNAL_BROWSER_CAPABILITY_TO_TOOL,
  EXTERNAL_BROWSER_TOOL_NAMES,
} from './external-browser-tool-definitions.mjs';
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

test('browser_hover and browser_scroll are registered as Desktop-only browser tools', () => {
  assert.equal(BROWSER_TOOL_NAMES.hover, 'browser_hover');
  assert.equal(BROWSER_TOOL_NAMES.scroll, 'browser_scroll');
  assert.equal(BROWSER_CAPABILITY_TO_TOOL['local.web.control.hover'], 'browser_hover');
  assert.equal(BROWSER_CAPABILITY_TO_TOOL['local.web.control.scroll'], 'browser_scroll');

  const registry = createRuntimeToolRegistry();
  const hover = registry.getTool('browser_hover');
  const scroll = registry.getTool('browser_scroll');
  assert.ok(hover);
  assert.ok(scroll);
  assert.equal(hover.capabilityId, 'local.web.control.hover');
  assert.equal(scroll.capabilityId, 'local.web.control.scroll');
  assert.ok(hover.inputSchema.properties.selector);
  assert.ok(scroll.inputSchema.properties.deltaY);
  assert.ok(scroll.inputSchema.properties.block);
});

test('browser_key and browser_drag are registered as Desktop-only browser tools', () => {
  assert.equal(BROWSER_TOOL_NAMES.key, 'browser_key');
  assert.equal(BROWSER_TOOL_NAMES.drag, 'browser_drag');
  assert.equal(BROWSER_CAPABILITY_TO_TOOL['local.web.control.key'], 'browser_key');
  assert.equal(BROWSER_CAPABILITY_TO_TOOL['local.web.control.drag'], 'browser_drag');

  const registry = createRuntimeToolRegistry();
  const key = registry.getTool('browser_key');
  const drag = registry.getTool('browser_drag');
  assert.ok(key);
  assert.ok(drag);
  assert.equal(key.capabilityId, 'local.web.control.key');
  assert.equal(drag.capabilityId, 'local.web.control.drag');
  assert.ok(key.inputSchema.properties.keys);
  assert.ok(drag.inputSchema.properties.fromSelector);
  assert.ok(drag.inputSchema.properties.toX);
});

test('browser_external_* tools are registered as Desktop-only L2 contracts', () => {
  assert.equal(EXTERNAL_BROWSER_TOOL_NAMES.open, 'browser_external_open');
  assert.equal(EXTERNAL_BROWSER_CAPABILITY_TO_TOOL['local.web.external.open'], 'browser_external_open');
  assert.equal(EXTERNAL_BROWSER_CAPABILITY_TO_TOOL['local.web.external.readDom'], 'browser_external_read_dom');

  const registry = createRuntimeToolRegistry();
  const open = registry.getTool('browser_external_open');
  const click = registry.getTool('browser_external_click');
  const screenshot = registry.getTool('browser_external_screenshot');
  assert.ok(open);
  assert.ok(click);
  assert.ok(screenshot);
  assert.equal(open.capabilityId, 'local.web.external.open');
  assert.equal(click.capabilityId, 'local.web.external.click');
  assert.equal(open.runtime.adapter, 'runtime-gateway.local-external-browser-provider');
  assert.ok(click.inputSchema.properties.selector);
  assert.equal(registry.getTool('browser_external_download'), null);
  assert.equal(registry.getTool('browser_external_dialog'), null);
  assert.equal(registry.getTool('playwright_click'), null);
  assert.equal(open.capabilityId.startsWith('local.web.control.'), false);
});
