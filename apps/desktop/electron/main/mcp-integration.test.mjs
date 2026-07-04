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
    assert.equal(permissionRequests[0].scope.effect, 'mutation');
    assert.equal(permissionRequests[0].scope.riskLevel, 'L3_external_write');
    assert.equal(permissionRequests[0].riskLevel, 'L3_external_write');
    assert.match(permissionRequests[0].reason, /MCP mutation tool/);
    assert.equal(execution.permissionGrant.granted, false);
    assert.equal(execution.permissionGrant.scope.kind, 'mcp-tool');
    assert.equal(execution.result.status, 'denied');
    assert.equal(execution.result.evidence.toolCallId, 'tc_mcp_1');
    assert.equal(execution.result.evidence.returnedToCloud, false);
  });

  it('classifies read-only MCP tools without mutation wording', async () => {
    const registry = createMcpRegistry();
    registry.upsertServer({
      id: 'reader',
      displayName: 'Reader MCP',
      transport: 'streamable_http',
      url: 'http://127.0.0.1:3929/mcp',
      enabled: true,
      policy: {
        trusted: true,
        visibleByDefault: true,
        requirePermission: true,
      },
      tools: [
        {
          name: 'lookup',
          description: 'Read-only lookup',
          riskLevel: 'L1_local_read',
          dataLevel: 'D1_internal',
          inputSchema: { type: 'object' },
        },
      ],
    });

    const provider = createLocalMcpProvider({ mcpRegistry: registry });
    const permissionRequests = [];
    const execution = await provider.executeCapability({
      call: {
        toolCallId: 'tc_mcp_read',
        capabilityId: 'local.mcp.reader.lookup',
        arguments: { id: '123' },
      },
    }, {
      locale: 'en-US',
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return { granted: false };
      },
    });

    assert.equal(permissionRequests.length, 1);
    assert.equal(permissionRequests[0].scope.effect, 'read');
    assert.equal(permissionRequests[0].scope.riskLevel, 'L1_local_read');
    assert.equal(permissionRequests[0].riskLevel, 'L1_local_read');
    assert.equal(permissionRequests[0].dataLevel, 'D1_internal');
    assert.match(permissionRequests[0].reason, /MCP read tool/);
    assert.equal(execution.result.status, 'denied');
  });

  it('resolves a dotted server.id end-to-end (regression: DingTalk-style host id)', async () => {
    // DingTalk-style server ids are derived from the host and contain dots, so the
    // generated capabilityId is `local.mcp.<dotted.server.id>.<toolName>` with several
    // dots. parseMcpCapabilityId must split on the LAST dot, otherwise the server
    // lookup uses a truncated id (e.g. only `https-mcp-gw`) and fails with
    // "MCP server not found", which is the original "can't connect" symptom.
    const dottedServerId =
      'https-mcp-gw.dingtalk.com-server-cb36f9198eefa69fad244089954ebe41451eddb20195e4e';
    const registry = createMcpRegistry();
    registry.upsertServer({
      id: dottedServerId,
      displayName: 'DingTalk MCP',
      transport: 'streamable_http',
      url: 'http://127.0.0.1:3932/mcp',
      enabled: true,
      policy: {
        trusted: true,
        visibleByDefault: true,
        requirePermission: true,
        maxRiskLevel: 'L4_privileged',
      },
      tools: [
        {
          name: 'get_document_info',
          description: 'Get DingTalk document info',
          inputSchema: { type: 'object' },
        },
      ],
    });

    const capabilityId = `local.mcp.${dottedServerId}.get_document_info`;
    const manifest = registry
      .listCapabilityManifests()
      .find((entry) => entry.capabilityId === capabilityId);
    assert.ok(manifest, 'manifest should be generated with the full dotted server.id');

    const provider = createLocalMcpProvider({ mcpRegistry: registry });
    const call = {
      toolCallId: 'tc_mcp_dotted',
      capabilityId,
      arguments: { nodeId: 'demo' },
    };
    const permissionRequests = [];

    const execution = await provider.executeCapability({ call }, {
      locale: 'en-US',
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return { granted: false };
      },
    });

    // The lookup must have reached the real server (not "MCP server not found"),
    // proving the dotted server.id survived parsing. We stop at the permission gate.
    assert.equal(permissionRequests.length, 1);
    assert.equal(permissionRequests[0].scope.serverId, dottedServerId);
    assert.equal(permissionRequests[0].scope.toolName, 'get_document_info');
    assert.equal(execution.result.status, 'denied');
    assert.notEqual(
      execution.result.outputPreview.reason,
      `MCP server not found: ${dottedServerId}`,
    );
  });

  it('adopts the server-reported name on refresh', () => {
    const registry = createMcpRegistry();
    const created = registry.upsertServer({
      id: 'reported-demo',
      displayName: 'My Custom Name',
      transport: 'streamable_http',
      url: 'http://127.0.0.1:3929/mcp',
      enabled: true,
    });
    assert.equal(created.displayName, 'My Custom Name');

    const refreshed = registry.updateManifest('reported-demo', {
      discoveredAt: new Date().toISOString(),
      serverInfo: { name: 'DingTalk Docs MCP', version: '2.1.0' },
      tools: [],
      resources: [],
      prompts: [],
      health: { status: 'ok', checkedAt: new Date().toISOString(), message: '' },
    });

    // Refresh Manifest adopts server-reported metadata as the visible name.
    assert.equal(refreshed.reportedName, 'DingTalk Docs MCP');
    assert.equal(refreshed.reportedVersion, '2.1.0');
    assert.equal(refreshed.displayName, 'DingTalk Docs MCP');
  });

  it('accepts OAuth auth bindings for automatically detected auth flows', () => {
    const registry = createMcpRegistry();
    const created = registry.upsertServer({
      id: 'oauth-demo',
      displayName: 'OAuth Demo',
      transport: 'streamable_http',
      url: 'https://mcp.example.com/mcp',
      enabled: true,
      auth: { mode: 'oauth2', credentialRef: 'mcp-cred:oauth-demo' },
    });

    assert.equal(created.auth.mode, 'oauth2');
    assert.equal(created.auth.credentialRef, 'mcp-cred:oauth-demo');
  });

  it('prefers the server-reported title over the protocol name on refresh', () => {
    const registry = createMcpRegistry();
    registry.upsertServer({
      id: 'titled-demo',
      displayName: 'My Custom Name',
      transport: 'streamable_http',
      url: 'http://127.0.0.1:3929/mcp',
      enabled: true,
    });

    const refreshed = registry.updateManifest('titled-demo', {
      discoveredAt: new Date().toISOString(),
      serverInfo: { name: 'dingtalk-mcp-long-id', title: 'DingTalk Docs MCP', version: '2.1.0' },
      tools: [],
      resources: [],
      prompts: [],
      health: { status: 'ok', checkedAt: new Date().toISOString(), message: '' },
    });

    assert.equal(refreshed.reportedName, 'dingtalk-mcp-long-id');
    assert.equal(refreshed.reportedTitle, 'DingTalk Docs MCP');
    assert.equal(refreshed.displayName, 'DingTalk Docs MCP');
  });
});
