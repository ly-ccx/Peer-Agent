import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';

import { createTuiSkillMcpBridge } from './skill-mcp-bridge.ts';

function completedExecution(call: Record<string, unknown>): RuntimeSdkProviderExecution {
  return {
    call: call as never,
    result: {
      toolCallId: String(call.toolCallId),
      status: 'completed',
      output: { ok: true },
      outputPreview: 'ok',
      evidence: {
        summary: 'ok',
        returnedToCloud: true,
        dataLevel: 'D1_internal',
      },
    },
  };
}

describe('TuiSkillMcpBridge', () => {
  test('loads local skills and MCP tools from the configured Peer Agent home', async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), 'peer-tui-skill-mcp-'));
    try {
      const skillDir = path.join(userDataPath, 'skills', 'demo-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), [
        '---',
        'name: Demo Skill',
        'description: Demo local skill',
        'whenToUse: Use for bridge tests',
        '---',
        '',
        '# Demo Skill',
      ].join('\n'));
      await writeFile(path.join(userDataPath, 'mcp-registry.json'), JSON.stringify({
        version: 1,
        servers: [{
          id: 'demo-server',
          displayName: 'Demo MCP',
          enabled: true,
          transport: 'streamable_http',
          url: 'https://example.invalid/mcp',
          policy: {
            trusted: true,
            visibleByDefault: true,
            requirePermission: false,
            maxRiskLevel: 'L4_privileged',
          },
          health: { status: 'ready' },
          tools: [{
            name: 'echo',
            description: 'Echo a message',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
            },
          }],
        }],
      }));

      const bridge = createTuiSkillMcpBridge({ userDataPath });
      expect(bridge.listSkillTools().map((tool) => tool.capabilityId)).toContain(
        'local.skill.demo-skill',
      );
      expect(bridge.listMcpTools().map((tool) => tool.capabilityId)).toContain(
        'local.mcp.demo-server.echo',
      );
      expect(bridge.discoveryHint()).toContain('demo-skill');
      expect(bridge.discoveryHint()).toContain('mcp__demo-server__echo');
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('manages Skill and MCP enabled state through the shared stores', () => {
    let skillEnabled = true;
    let serverEnabled = true;
    let skillRefreshes = 0;
    const skillStore = {
      listSkills: () => [{ skillId: 'demo', name: 'Demo', enabled: skillEnabled }],
      readSkillContext: () => ({}),
      refresh() { skillRefreshes += 1; return this.listSkills(); },
      enableSkill() { skillEnabled = true; return this.listSkills(); },
      disableSkill() { skillEnabled = false; return this.listSkills(); },
    };
    const mcpRegistry = {
      listCapabilityManifests: () => [],
      listInstalled: () => [{ id: 'demo', displayName: 'Demo MCP', enabled: serverEnabled, toolsCount: 1, visibleToolsCount: 1, health: { status: 'connected' }, tools: [{ name: 'echo' }] }],
      setEnabled(_id: string, enabled: boolean) { serverEnabled = enabled; },
    };
    const bridge = createTuiSkillMcpBridge({
      userDataPath: '/unused-peer-home',
      skillStore,
      mcpRegistry,
      skillProvider: { capabilityPrefix: 'local.skill.', executeCapability: async () => null },
      mcpProvider: { capabilityPrefix: 'local.mcp.', executeCapability: async () => null },
    });

    expect(bridge.setSkillEnabled('demo', false)[0]?.enabled).toBe(false);
    expect(bridge.refreshSkills()[0]?.skillId).toBe('demo');
    expect(skillRefreshes).toBe(1);
    expect(bridge.setMcpServerEnabled('demo', false)[0]?.enabled).toBe(false);
    expect(bridge.refreshMcp()[0]?.tools[0]?.name).toBe('echo');
  });

  test('routes projected Skill and MCP capabilities to their providers', async () => {
    const calls: string[] = [];
    const skillStore = {
      listSkills: () => [{
        skillId: 'demo-skill',
        name: 'Demo Skill',
        enabled: true,
      }],
      readSkillContext: () => ({}),
      refresh() { return this.listSkills(); },
      enableSkill() { return this.listSkills(); },
      disableSkill() { return this.listSkills(); },
    };
    const mcpRegistry = {
      listCapabilityManifests: () => [{
        capabilityId: 'local.mcp.demo-server.echo',
        name: 'mcp__demo-server__echo',
        description: 'Echo a message',
        inputSchema: { type: 'object' },
      }],
      listInstalled: () => [],
      setEnabled: () => ({}),
    };
    const provider = (prefix: string) => ({
      capabilityPrefix: prefix,
      async executeCapability(request: { call: Record<string, unknown> }) {
        calls.push(String(request.call.capabilityId));
        return completedExecution(request.call);
      },
    });
    const bridge = createTuiSkillMcpBridge({
      userDataPath: '/tmp/unused-peer-home',
      skillStore,
      mcpRegistry,
      skillProvider: provider('local.skill.') as never,
      mcpProvider: provider('local.mcp.') as never,
    });

    await bridge.execute({
      capabilityId: 'local.skill.demo-skill',
      args: { userMessage: 'use it' },
      toolCallId: 'skill-call',
    });
    await bridge.execute({
      capabilityId: 'local.mcp.demo-server.echo',
      args: { message: 'hello' },
      toolCallId: 'mcp-call',
    });

    expect(calls).toEqual([
      'local.skill.demo-skill',
      'local.mcp.demo-server.echo',
    ]);
  });
});
