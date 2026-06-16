import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createMcpRegistry } from './mcp-registry.mjs';
import { createRuntimeToolProjection } from './tools/index.mjs';
import { createLocalMcpProvider } from './runtime-gateway/local-mcp-provider.mjs';

let tmpDir;
let previousPeerAgentHome;

describe('MCP integration runtime chain', () => {
  beforeEach(() => {
    previousPeerAgentHome = process.env.PEER_AGENT_HOME;
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'peer-agent-mcp-test-'));
    process.env.PEER_AGENT_HOME = tmpDir;
  });

  afterEach(() => {
    if (previousPeerAgentHome === undefined) {
      delete process.env.PEER_AGENT_HOME;
    } else {
      process.env.PEER_AGENT_HOME = previousPeerAgentHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('projects only enabled and visible MCP tools into Runtime Projection', () => {
    const registry = createMcpRegistry();
    registry.upsertServer({
      id: 'demo',
      displayName: 'Demo MCP',
      transport: 'streamable_http',
      url: 'http://127.0.0.1:3929/mcp',
      enabled: true,
      policy: {
        trusted: true,
        visibleByDefault: true,
        requirePermission: true,
        maxRiskLevel: 'L4_privileged',
      },
      tools: [
        {
          name: 'visibleTool',
          description: 'Visible MCP tool',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
          },
        },
        {
          name: 'hiddenTool',
          description: 'Hidden MCP tool',
          inputSchema: { type: 'object' },
        },
      ],
      toolVisibility: {
        hiddenTool: false,
      },
    });

    const { registry: toolRegistry, projection } = createRuntimeToolProjection({ mcpRegistry: registry });
    const projectedNames = projection.capabilities.map((capability) => capability.name);

    assert.ok(toolRegistry.getTool('mcp__demo__visibleTool'));
    assert.equal(toolRegistry.getTool('mcp__demo__visibleTool').capabilityId, 'local.mcp.demo.visibleTool');
    assert.ok(projectedNames.includes('mcp__demo__visibleTool'));
    assert.equal(projectedNames.includes('mcp__demo__hiddenTool'), false);

    const projectedTool = toolRegistry.getTool('mcp__demo__visibleTool');
    const projectedCapability = projection.capabilities.find((capability) => capability.name === 'mcp__demo__visibleTool');
    assert.equal(projectedTool.capabilityId, 'local.mcp.demo.visibleTool');
    assert.equal(projectedTool.runtime.executorCapabilityId, 'local.mcp.demo.visibleTool');
    assert.equal(projectedTool.permissionPolicy.kind, 'mcp-tool');
    assert.equal(projectedCapability.source, 'mcp');
    assert.equal(projectedCapability.capabilityId, 'local.mcp.demo.visibleTool');
  });

  it('preserves SSE transport when registering MCP servers', () => {
    const registry = createMcpRegistry();
    registry.upsertServer({
      id: 'legacy-sse',
      displayName: 'Legacy SSE MCP',
      transport: 'sse',
      url: 'http://127.0.0.1:3930/sse',
      enabled: true,
      tools: [
        {
          name: 'legacyTool',
          description: 'Legacy SSE MCP tool',
          inputSchema: { type: 'object' },
        },
      ],
    });

    const server = registry.getServer('legacy-sse');
    const installed = registry.listInstalled().find((entry) => entry.id === 'legacy-sse');
    const manifest = registry.listCapabilityManifests().find((entry) => entry.capabilityId === 'local.mcp.legacy-sse.legacyTool');

    assert.equal(server.transport, 'sse');
    assert.equal(installed.transport, 'sse');
    assert.equal(manifest.origin.transport, 'sse');
    assert.equal(manifest.name, 'mcp__legacy-sse__legacyTool');
  });

  it('stores only opaque MCP auth bindings in registry and manifest origin', () => {
    const registry = createMcpRegistry();
    registry.upsertServer({
      id: 'auth-demo',
      displayName: 'Auth MCP',
      transport: 'streamable_http',
      url: 'http://127.0.0.1:3931/mcp',
      enabled: true,
      auth: {
        mode: 'http_bearer',
        credentialRef: 'mcp-cred:test-token',
      },
      tools: [
        {
          name: 'authTool',
          description: 'Authenticated MCP tool',
          inputSchema: { type: 'object' },
        },
      ],
    });

    const installed = registry.listInstalled().find((entry) => entry.id === 'auth-demo');
    const manifest = registry.listCapabilityManifests().find((entry) => entry.capabilityId === 'local.mcp.auth-demo.authTool');

    assert.deepEqual(installed.auth, { mode: 'http_bearer', credentialRef: 'mcp-cred:test-token' });
    assert.equal(JSON.stringify(installed).includes('secret'), false);
    assert.equal(manifest.origin.authMode, 'http_bearer');
    assert.equal(manifest.origin.hasCredential, true);
  });

  it('executes MCP provider through request.call and preserves PermissionGrant denial', async () => {
    const registry = createMcpRegistry();
    registry.upsertServer({
      id: 'demo',
      displayName: 'Demo MCP',
      transport: 'streamable_http',
      url: 'http://127.0.0.1:3929/mcp',
      enabled: true,
      policy: {
        trusted: true,
        visibleByDefault: true,
        requirePermission: true,
        maxRiskLevel: 'L4_privileged',
      },
      tools: [
        {
          name: 'visibleTool',
          description: 'Visible MCP tool',
          inputSchema: { type: 'object' },
        },
      ],
    });

    const provider = createLocalMcpProvider({ mcpRegistry: registry });
    const call = {
      toolCallId: 'tc_mcp_1',
      capabilityId: 'local.mcp.demo.visibleTool',
      arguments: { query: 'hello' },
    };
    const permissionRequests = [];

    const execution = await provider.executeCapability({ call }, {
      locale: 'zh-CN',
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return { granted: false };
      },
    });

    assert.equal(execution.call, call);
    assert.equal(permissionRequests.length, 1);
    assert.equal(permissionRequests[0].capabilityId, 'local.mcp.demo.visibleTool');
    assert.equal(permissionRequests[0].scope.kind, 'mcp-tool');
    assert.equal(permissionRequests[0].scope.serverId, 'demo');
    assert.equal(permissionRequests[0].scope.toolName, 'visibleTool');
    assert.equal(execution.permissionGrant.granted, false);
    assert.equal(execution.permissionGrant.scope.kind, 'mcp-tool');
    assert.equal(execution.result.status, 'denied');
    assert.equal(execution.result.evidence.toolCallId, 'tc_mcp_1');
    assert.equal(execution.result.evidence.returnedToCloud, false);
  });
});
