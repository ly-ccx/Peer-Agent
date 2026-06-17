import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const CLIENT_INFO = { name: 'peer-agent', version: '1.0.0' };
const CLIENT_CAPABILITIES = { capabilities: {} };
const DEFAULT_TIMEOUT_MS = 30_000;

const pool = new Map();

function nowIso() {
  return new Date().toISOString();
}

function asPlainStringRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => typeof item === 'string')
      .map(([key, item]) => [String(key), item]),
  );
}

function normalizeAuthContext(value) {
  if (!value || typeof value !== 'object') return { mode: 'none', hasCredential: false };
  return {
    mode: typeof value.mode === 'string' ? value.mode : 'none',
    credentialRef: typeof value.credentialRef === 'string' ? value.credentialRef : undefined,
    credentialUpdatedAt: typeof value.credentialUpdatedAt === 'string' ? value.credentialUpdatedAt : undefined,
    headerName: typeof value.headerName === 'string' ? value.headerName : undefined,
    envName: typeof value.envName === 'string' ? value.envName : undefined,
    hasCredential: Boolean(value.hasCredential),
  };
}

function authCacheKey(authContext) {
  const auth = normalizeAuthContext(authContext);
  if (!auth.hasCredential || auth.mode === 'none') return 'auth:none';
  return [
    'auth',
    auth.mode,
    auth.credentialRef ?? '',
    auth.credentialUpdatedAt ?? '',
    auth.headerName ?? '',
    auth.envName ?? '',
  ].join(':');
}

function serverKey(server) {
  if (typeof server === 'string') return `streamable_http:${server}:auth:none`;
  const transport = server?.transport === 'stdio' ? 'stdio' : server?.transport === 'sse' ? 'sse' : 'streamable_http';
  const revision = server?.updatedAt ?? server?.manifestUpdatedAt ?? '';
  const authKey = authCacheKey(server?.__authContext);
  if (transport === 'stdio') {
    return [
      'stdio',
      server?.id ?? '',
      server?.command ?? '',
      (server?.args ?? []).join('\u0000'),
      server?.cwd ?? '',
      revision,
      authKey,
    ].join(':');
  }
  return [transport, server?.id ?? '', server?.url ?? server?.serverUrl ?? '', revision, authKey].join(':');
}

function normalizeServerConfig(server) {
  if (typeof server === 'string') {
    return {
      id: server,
      transport: 'streamable_http',
      url: server,
      headers: {},
      env: {},
      auth: { mode: 'none' },
      __authContext: { mode: 'none', hasCredential: false },
    };
  }
  const transport = server?.transport === 'stdio' ? 'stdio' : server?.transport === 'sse' ? 'sse' : 'streamable_http';
  return {
    ...server,
    transport,
    url: server?.url ?? server?.serverUrl ?? '',
    args: Array.isArray(server?.args) ? server.args.filter((item) => typeof item === 'string') : [],
    headers: asPlainStringRecord(server?.headers),
    env: asPlainStringRecord(server?.env),
    auth: server?.auth && typeof server.auth === 'object' ? server.auth : { mode: 'none' },
    __authContext: normalizeAuthContext(server?.__authContext),
  };
}

async function prepareServerConfig(server, options = {}) {
  const config = normalizeServerConfig(server);
  const auth = config.auth && typeof config.auth === 'object' ? config.auth : { mode: 'none' };
  if (!auth?.mode || auth.mode === 'none') {
    return {
      ...config,
      __authContext: { mode: 'none', hasCredential: false },
    };
  }
  if (typeof options.credentialResolver !== 'function') {
    throw new Error('MCP credential resolver is required for authenticated server.');
  }
  const injection = await options.credentialResolver(auth, config);
  const authContext = normalizeAuthContext(injection?.authContext);
  return {
    ...config,
    headers: {
      ...(config.headers ?? {}),
      ...asPlainStringRecord(injection?.headers),
    },
    env: {
      ...(config.env ?? {}),
      ...asPlainStringRecord(injection?.env),
    },
    __authContext: authContext,
  };
}

function createTransport(server) {
  const config = normalizeServerConfig(server);
  if (config.transport === 'stdio') {
    if (!config.command) throw new Error('MCP stdio server requires command.');
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      cwd: config.cwd || undefined,
      env: { ...process.env, ...(config.env ?? {}) },
      stderr: 'pipe',
    });
  }
  if (!config.url) throw new Error('MCP HTTP server requires url.');
  const requestInit = Object.keys(config.headers ?? {}).length > 0
    ? { headers: config.headers }
    : undefined;
  if (config.transport === 'sse') {
    return new SSEClientTransport(new URL(config.url), { requestInit });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), { requestInit });
}

async function connect(server, options = {}) {
  const config = await prepareServerConfig(server, options);
  const key = serverKey(config);
  const existing = pool.get(key);
  if (existing) return existing;

  const client = new Client(CLIENT_INFO, CLIENT_CAPABILITIES);
  const transport = createTransport(config);
  await client.connect(transport);
  const entry = { key, client, transport, server: config, connectedAt: nowIso() };
  pool.set(key, entry);
  return entry;
}

async function withClient(server, fn, options = {}) {
  const entry = await connect(server, options);
  return fn(entry.client, entry);
}

function safeArray(value, key) {
  const list = value?.[key];
  return Array.isArray(list) ? list : [];
}

function normalizeTool(tool) {
  return {
    name: String(tool?.name ?? ''),
    description: typeof tool?.description === 'string' ? tool.description : '',
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', additionalProperties: true },
  };
}

function normalizeResource(resource) {
  return {
    uri: String(resource?.uri ?? ''),
    name: typeof resource?.name === 'string' ? resource.name : String(resource?.uri ?? ''),
    description: typeof resource?.description === 'string' ? resource.description : '',
    mimeType: typeof resource?.mimeType === 'string' ? resource.mimeType : '',
  };
}

function normalizePrompt(prompt) {
  return {
    name: String(prompt?.name ?? ''),
    description: typeof prompt?.description === 'string' ? prompt.description : '',
    arguments: Array.isArray(prompt?.arguments) ? prompt.arguments : [],
  };
}

function readServerInfo(client) {
  // serverInfo is reported by the server during the MCP initialize handshake
  // and cached by the SDK. Treat it as factual metadata, never a secret.
  try {
    const info = client.getServerVersion?.();
    if (!info || typeof info !== 'object') return undefined;
    const name = typeof info.name === 'string' ? info.name.trim() : '';
    const version = typeof info.version === 'string' ? info.version.trim() : '';
    if (!name && !version) return undefined;
    return {
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function discoverMcpManifest(server, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  return withClient(server, async (client) => {
    const [toolsResult, resourcesResult, promptsResult] = await Promise.allSettled([
      client.listTools({}, { timeout }),
      client.listResources({}, { timeout }),
      client.listPrompts({}, { timeout }),
    ]);

    const errors = [];
    if (toolsResult.status === 'rejected') errors.push({ kind: 'tools', message: toolsResult.reason?.message ?? String(toolsResult.reason) });
    if (resourcesResult.status === 'rejected') errors.push({ kind: 'resources', message: resourcesResult.reason?.message ?? String(resourcesResult.reason) });
    if (promptsResult.status === 'rejected') errors.push({ kind: 'prompts', message: promptsResult.reason?.message ?? String(promptsResult.reason) });

    const tools = toolsResult.status === 'fulfilled'
      ? safeArray(toolsResult.value, 'tools').map(normalizeTool).filter((tool) => tool.name)
      : [];
    const resources = resourcesResult.status === 'fulfilled'
      ? safeArray(resourcesResult.value, 'resources').map(normalizeResource).filter((resource) => resource.uri)
      : [];
    const prompts = promptsResult.status === 'fulfilled'
      ? safeArray(promptsResult.value, 'prompts').map(normalizePrompt).filter((prompt) => prompt.name)
      : [];

    return {
      discoveredAt: nowIso(),
      serverInfo: readServerInfo(client),
      tools,
      resources,
      prompts,
      errors,
      auth: entryAuthMetadata(client),
      health: {
        status: errors.length === 3 ? 'failed' : 'ok',
        checkedAt: nowIso(),
        message: errors.length ? errors.map((error) => `${error.kind}: ${error.message}`).join('; ') : '',
      },
    };
  }, options);
}

function entryAuthMetadata(client) {
  // Kept as a seam for future MCP OAuth/session metadata. Never include secrets.
  void client;
  return undefined;
}

export async function testMcpConnection(server, options = {}) {
  try {
    const manifest = await discoverMcpManifest(server, options);
    return {
      ok: manifest.health.status !== 'failed',
      health: manifest.health,
      toolsCount: manifest.tools.length,
      resourcesCount: manifest.resources.length,
      promptsCount: manifest.prompts.length,
      errors: manifest.errors,
    };
  } catch (error) {
    return {
      ok: false,
      health: {
        status: 'failed',
        checkedAt: nowIso(),
        message: error?.message ?? String(error),
      },
      toolsCount: 0,
      resourcesCount: 0,
      promptsCount: 0,
      errors: [{ kind: 'connection', message: error?.message ?? String(error) }],
    };
  }
}

export async function listMcpTools(server, options = {}) {
  const manifest = await discoverMcpManifest(server, options);
  return manifest.tools;
}

export async function callMcpTool(server, toolName, args = {}, options = {}) {
  if (!toolName) throw new Error('MCP toolName is required.');
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  return withClient(server, async (client) => {
    const result = await client.callTool({ name: toolName, arguments: args ?? {} }, undefined, { timeout });
    return normalizeMcpToolResult(result);
  }, options);
}

export async function readMcpResource(server, uri, options = {}) {
  if (!uri) throw new Error('MCP resource uri is required.');
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  return withClient(server, async (client) => client.readResource({ uri }, { timeout }), options);
}

export async function getMcpPrompt(server, name, args = {}, options = {}) {
  if (!name) throw new Error('MCP prompt name is required.');
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  return withClient(server, async (client) => client.getPrompt({ name, arguments: args ?? {} }, { timeout }), options);
}

function textFromContentItem(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'text' && typeof item.text === 'string') return item.text;
  if (typeof item.text === 'string') return item.text;
  if (typeof item.data === 'string') return item.data;
  return '';
}

function extractTextContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map(textFromContentItem).filter(Boolean).join('\n');
}

export function normalizeMcpToolResult(result) {
  const text = extractTextContent(result?.content);
  return {
    raw: result ?? null,
    content: Array.isArray(result?.content) ? result.content : [],
    text: text || safeStringify(result ?? {}),
    isError: Boolean(result?.isError),
    structuredContent: result?.structuredContent ?? null,
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sameServer(left, right) {
  const a = normalizeServerConfig(left);
  const b = normalizeServerConfig(right);
  if (a.id && b.id && a.id === b.id) return true;
  if (a.transport !== b.transport) return false;
  if (a.transport === 'stdio') {
    return a.command === b.command && (a.args ?? []).join('\u0000') === (b.args ?? []).join('\u0000') && (a.cwd ?? '') === (b.cwd ?? '');
  }
  return (a.url ?? '') === (b.url ?? '');
}

export function disconnectMcp(server) {
  for (const [key, entry] of pool.entries()) {
    if (sameServer(entry.server, server)) {
      try { entry.client.close(); } catch {}
      try { entry.transport.close?.(); } catch {}
      pool.delete(key);
    }
  }
}

export function disconnectAll() {
  for (const [key, entry] of pool.entries()) {
    try { entry.client.close(); } catch {}
    try { entry.transport.close?.(); } catch {}
    pool.delete(key);
  }
}

export const __mcpClientInternals = {
  prepareServerConfig,
  serverKey,
  createTransport,
};
