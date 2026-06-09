import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const CLIENT_INFO = { name: 'peer-agent', version: '1.0.0' };

const pool = new Map();

function extractTextContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim();
}

export async function getOrCreateClient(serverUrl, authProvider) {
  const existing = pool.get(serverUrl);
  if (existing?.client) return existing;

  const transport = new StreamableHTTPClientTransport(
    new URL(serverUrl),
    authProvider ? { authProvider } : undefined,
  );
  const client = new Client(CLIENT_INFO, { capabilities: {} });

  try {
    await client.connect(transport);
  } catch (err) {
    if (err?.constructor?.name === 'UnauthorizedError' && authProvider) {
      const code = await authProvider.redirectToAuthorization(
        new URL(err.authorizationUrl || serverUrl),
      );
      if (code) {
        await transport.finishAuth(code);
        await client.connect(transport);
      } else {
        throw new Error('用户取消了 MCP 授权');
      }
    } else {
      throw err;
    }
  }

  const entry = { client, transport };
  pool.set(serverUrl, entry);
  return entry;
}

export async function listMcpTools(serverUrl, authProvider) {
  const { client } = await getOrCreateClient(serverUrl, authProvider);
  const { tools } = await client.listTools();
  return tools;
}

export async function callMcpTool(serverUrl, toolName, args, timeout = 90000, authProvider) {
  const { client } = await getOrCreateClient(serverUrl, authProvider);
  const result = await client.callTool({ name: toolName, arguments: args || {} });

  if (!result) return null;
  if (result.isError === true) {
    throw new Error(extractTextContent(result.content) || `MCP tool call failed: ${toolName}`);
  }
  const text = extractTextContent(result.content);
  if (!text) return result.content ?? result;
  try { return JSON.parse(text); } catch { return text; }
}

export function disconnectMcp(serverUrl) {
  const entry = pool.get(serverUrl);
  if (entry) {
    try { entry.client.close(); } catch {}
    pool.delete(serverUrl);
  }
}

export function disconnectAll() {
  for (const [url] of pool) disconnectMcp(url);
}
