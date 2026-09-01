import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESKTOP_ONLY_LOCAL_TOOL_CONTRACT_LIST,
  LEGACY_LOCAL_CAPABILITY_ID_ALIASES,
  LEGACY_LOCAL_MODEL_TOOL_NAME_ALIASES,
  SHARED_LOCAL_TOOL_CONTRACT_LIST,
  SHARED_LOCAL_TOOL_CONTRACTS,
  canonicalizeLocalCapabilityId,
  canonicalizeLocalModelToolName,
  isParallelSafeLocalToolBatch,
  isSharedLocalCapabilityId,
  isSharedLocalToolName,
} from './local-tool-contracts.ts';

test('shared local tool contracts expose one unique canonical name and ID per capability', () => {
  assert.deepEqual(SHARED_LOCAL_TOOL_CONTRACTS, {
    readFile: { toolName: 'read_file', capabilityId: 'local.file.read' },
    listFiles: { toolName: 'list_files', capabilityId: 'local.file.list' },
    searchFiles: { toolName: 'search_files', capabilityId: 'local.file.search' },
    editFile: { toolName: 'edit_file', capabilityId: 'local.file.edit' },
    writeFile: { toolName: 'write_file', capabilityId: 'local.file.write' },
    shellExec: { toolName: 'bash', capabilityId: 'local.shell.exec' },
    shellStop: { toolName: 'shell_stop', capabilityId: 'local.shell.stop' },
    batchSearch: { toolName: 'batch_search', capabilityId: 'local.search.aggregate' },
    webFetch: { toolName: 'web_fetch', capabilityId: 'local.web.fetch' },
    requestUserInput: {
      toolName: 'request_user_input',
      capabilityId: 'local.interaction.request_user_input',
    },
    goalCreatePlan: {
      toolName: 'goal_create_plan',
      capabilityId: 'local.goal.create_plan',
    },
    goalUpdateTask: {
      toolName: 'goal_update_task',
      capabilityId: 'local.goal.update_task',
    },
    goalGetPlan: {
      toolName: 'goal_get_plan',
      capabilityId: 'local.goal.get_plan',
    },
    requestExplorer: {
      toolName: 'request_explorer',
      capabilityId: 'local.goal.explore',
    },
  });

  const names = SHARED_LOCAL_TOOL_CONTRACT_LIST.map((contract) => contract.toolName);
  const capabilityIds = SHARED_LOCAL_TOOL_CONTRACT_LIST.map(
    (contract) => contract.capabilityId,
  );
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(capabilityIds).size, capabilityIds.length);
  assert.ok(names.every(isSharedLocalToolName));
  assert.ok(capabilityIds.every(isSharedLocalCapabilityId));
});

test('legacy names and capability IDs normalize without entering the canonical set', () => {
  assert.deepEqual(LEGACY_LOCAL_CAPABILITY_ID_ALIASES, {
    'local.goal.create': 'local.goal.create_plan',
    'local.goal.update': 'local.goal.update_task',
    'local.goal.read': 'local.goal.get_plan',
    'local.search.content': 'local.file.search',
  });
  assert.deepEqual(LEGACY_LOCAL_MODEL_TOOL_NAME_ALIASES, {
    local_shell_exec: 'bash',
  });

  for (const [legacy, canonical] of Object.entries(LEGACY_LOCAL_CAPABILITY_ID_ALIASES)) {
    assert.equal(canonicalizeLocalCapabilityId(legacy), canonical);
    assert.equal(isSharedLocalCapabilityId(legacy), false);
  }
  assert.equal(canonicalizeLocalCapabilityId('local.file.read'), 'local.file.read');
  assert.equal(canonicalizeLocalModelToolName('local_shell_exec'), 'bash');
  assert.equal(canonicalizeLocalModelToolName('read_file'), 'read_file');
});

test('Desktop-only browser contracts are explicit and excluded from shared parity', () => {
  assert.deepEqual(DESKTOP_ONLY_LOCAL_TOOL_CONTRACT_LIST, [
    { toolName: 'browser_open_panel', capabilityId: 'local.web.control.openPanel' },
    { toolName: 'browser_navigate', capabilityId: 'local.web.control.navigate' },
    { toolName: 'browser_click', capabilityId: 'local.web.control.click' },
    { toolName: 'browser_type', capabilityId: 'local.web.control.type' },
    { toolName: 'browser_screenshot', capabilityId: 'local.web.control.screenshot' },
    { toolName: 'browser_read_dom', capabilityId: 'local.web.control.readDom' },
    { toolName: 'browser_hover', capabilityId: 'local.web.control.hover' },
    { toolName: 'browser_scroll', capabilityId: 'local.web.control.scroll' },
    { toolName: 'browser_key', capabilityId: 'local.web.control.key' },
    { toolName: 'browser_drag', capabilityId: 'local.web.control.drag' },
  ]);

  for (const contract of DESKTOP_ONLY_LOCAL_TOOL_CONTRACT_LIST) {
    assert.equal(isSharedLocalToolName(contract.toolName), false);
    assert.equal(isSharedLocalCapabilityId(contract.capabilityId), false);
  }
});

test('only an all-read file batch is parallel-safe', () => {
  assert.equal(isParallelSafeLocalToolBatch([
    { capabilityId: 'local.file.read' },
    { capabilityId: 'local.file.search' },
  ]), true);
  assert.equal(isParallelSafeLocalToolBatch([
    { capabilityId: 'local.file.read' },
  ]), false);
  assert.equal(isParallelSafeLocalToolBatch([
    { capabilityId: 'local.file.read' },
    { capabilityId: 'local.shell.exec' },
  ]), false);
  assert.equal(isParallelSafeLocalToolBatch([
    { capabilityId: 'local.file.read' },
    {},
  ]), false);
});
