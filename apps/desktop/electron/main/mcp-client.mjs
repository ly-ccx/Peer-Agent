// Desktop compatibility seam. MCP transport and client lifecycle are owned by runtime-node.
export {
  __mcpClientInternals,
  callMcpTool,
  disconnectAll,
  disconnectMcp,
  discoverMcpManifest,
  finishMcpOAuth,
  getMcpPrompt,
  listMcpTools,
  normalizeMcpToolResult,
  probeMcpConnection,
  readMcpResource,
  startMcpOAuth,
  testMcpConnection,
} from '@peer-agent/runtime-node';
