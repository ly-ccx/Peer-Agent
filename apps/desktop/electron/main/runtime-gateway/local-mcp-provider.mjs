import { callMcpTool } from '../mcp-client.mjs';
import { createElectronOAuthProvider } from '../mcp-oauth-provider.mjs';

const MCP_CAPABILITY_PREFIX = 'local.mcp.';

function parseMcpCapabilityId(capabilityId) {
  const rest = capabilityId.slice(MCP_CAPABILITY_PREFIX.length);
  const dotIndex = rest.indexOf('.');
  if (dotIndex < 0) return null;
  return { mcpId: rest.slice(0, dotIndex), toolName: rest.slice(dotIndex + 1) };
}

export function createLocalMcpProvider({ mcpRegistry }) {
  async function executeCapability(request) {
    const call = request.call;
    const capabilityId = call.capabilityId || '';
    const parsed = parseMcpCapabilityId(capabilityId);
    if (!parsed) {
      return { call, result: { status: 'failed', error: `Invalid MCP capability: ${capabilityId}` } };
    }

    const installed = mcpRegistry.listInstalled();
    const server = installed.find((item) => String(item.mcpId) === parsed.mcpId);
    if (!server) {
      return { call, result: { status: 'failed', error: `MCP server ${parsed.mcpId} not installed` } };
    }

    const serverUrl = server.serverUrl || server.dingtalkActivation?.serverUrl;
    if (!serverUrl) {
      return { call, result: { status: 'failed', error: `MCP server ${server.name} has no serverUrl` } };
    }

    const authProvider = server.source === 'aone' ? await createElectronOAuthProvider(serverUrl) : undefined;
    try {
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments || {});
      const toolResult = await callMcpTool(serverUrl, parsed.toolName, args, 90000, authProvider);
      return {
        call,
        result: {
          status: 'success',
          evidence: {
            type: 'mcp_tool_result',
            content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
          },
          outputPreview: typeof toolResult === 'string' ? toolResult.slice(0, 500) : JSON.stringify(toolResult).slice(0, 500),
        },
      };
    } catch (err) {
      return { call, result: { status: 'failed', error: err?.message || `MCP tool ${parsed.toolName} execution failed` } };
    } finally {
      authProvider?.close?.();
    }
  }

  return {
    providerId: 'local-mcp',
    capabilityPrefix: MCP_CAPABILITY_PREFIX,
    executeCapability,
  };
}
