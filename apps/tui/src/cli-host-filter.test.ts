import { describe, expect, test } from 'bun:test';

import { denyInteractiveTools, restrictTuiHostTools } from './cli-host-filter.ts';
import type { TuiHost } from './tui-host.ts';

function host(): TuiHost {
  return {
    workspaceRoot: '/tmp/ws',
    capabilities: ['local.file.read', 'local.web.fetch', 'local.interaction.request_user_input'],
    toolDefinitions: [
      { name: 'read_file', capabilityId: 'local.file.read' },
      { name: 'web_fetch', capabilityId: 'local.web.fetch' },
      { name: 'request_user_input', capabilityId: 'local.interaction.request_user_input' },
    ],
    getAccessLevel: () => 'session_local',
    setAccessLevel: () => 'session_local',
    toolDefinitionsForMode: () => [
      { name: 'read_file', capabilityId: 'local.file.read' },
      { name: 'web_fetch', capabilityId: 'local.web.fetch' },
    ],
    execute: async (capabilityId) => ({
      result: { status: 'success', capabilityId, outputPreview: capabilityId },
    } as never),
    executeRead: async () => ({ result: { status: 'success' } } as never),
    executeShell: async () => ({ result: { status: 'success' } } as never),
    subscribe: () => () => {},
    subscribeApproval: () => () => {},
    dispose: async () => {},
  };
}

describe('restrictTuiHostTools', () => {
  test('hides web/mcp-like tools from the model projection', () => {
    const filtered = restrictTuiHostTools(host(), ['local.file.read']);
    expect(filtered.toolDefinitions.map((tool) => tool.capabilityId)).toEqual(['local.file.read']);
    expect(filtered.toolDefinitionsForMode?.('chat').map((tool) => tool.capabilityId))
      .toEqual(['local.file.read']);
  });

  test('denies execute for tools outside the allowlist', async () => {
    const filtered = restrictTuiHostTools(host(), ['local.file.read']);
    const denied = await filtered.execute('local.web.fetch', {});
    expect(denied.result.status).toBe('failed');
    expect(String((denied.result.error as { message?: string } | undefined)?.message ?? ''))
      .toContain('outside --tools');
  });
});

describe('denyInteractiveTools', () => {
  test('fails request_user_input without hanging', async () => {
    const filtered = denyInteractiveTools(host());
    const denied = await filtered.execute('local.interaction.request_user_input', {});
    expect(denied.result.status).toBe('failed');
    expect(String((denied.result.error as { message?: string } | undefined)?.message ?? ''))
      .toContain('without a TTY');
  });
});
