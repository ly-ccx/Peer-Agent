import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const CLIENT_INFO = { name: 'peer-agent', version: '1.0.0' };
const CLIENT_CAPABILITIES = { capabilities: {} };
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OAUTH_REDIRECT_URL = 'http://127.0.0.1:33418/mcp/oauth/callback';

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
    oauth: value.oauth && typeof value.oauth === 'object' ? value.oauth : undefined,
    authProviderConfig: value.authProviderConfig && typeof value.authProviderConfig === 'object' ? value.authProviderConfig : undefined,
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
    auth.mode === 'oauth2' ? JSON.stringify({
      tokenStatus: auth.oauth?.tokenStatus ?? '',
      expiresAt: auth.oauth?.expiresAt ?? '',
      clientId: auth.oauth?.clientId ?? '',
    }) : '',
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
  // OAuth 凭据解析器把 authProviderConfig 作为 authContext 的兄弟字段返回（其中携带
  // oauth/updateOAuth/openAuthorizationUrl）。若不在此处合并进 authContext，
  // createOAuthProvider 永远拿不到 provider 配置，OAuth 流程会被静默跳过。
  const authContext = normalizeAuthContext({
    ...(injection?.authContext ?? {}),
    authProviderConfig: injection?.authProviderConfig ?? injection?.authContext?.authProviderConfig,
  });
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

function createOAuthProvider(server) {
  const authContext = normalizeAuthContext(server?.__authContext);
  const providerConfig = authContext.authProviderConfig;
  if (authContext.mode !== 'oauth2' || !providerConfig?.oauth || !providerConfig?.credentialRef) return undefined;
  const oauth = providerConfig.oauth;
  const redirectUrl = typeof oauth.redirectUrl === 'string' && oauth.redirectUrl ? oauth.redirectUrl : DEFAULT_OAUTH_REDIRECT_URL;
  const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.filter((scope) => typeof scope === 'string' && scope.trim()) : [];
  const updateOAuth = typeof providerConfig.updateOAuth === 'function' ? providerConfig.updateOAuth : async () => {};
  const clientMetadata = {
    client_name: CLIENT_INFO.name,
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: oauth.clientSecret ? 'client_secret_post' : 'none',
    scope: scopes.join(' '),
    ...(oauth.clientId ? { client_id: oauth.clientId } : {}),
    ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
  };
  let codeVerifier = typeof oauth.codeVerifier === 'string' ? oauth.codeVerifier : '';
  return {
    get redirectUrl() { return redirectUrl; },
    get clientMetadata() { return clientMetadata; },
    state() { return undefined; },
    clientInformation() { return oauth.clientInformation; },
    async saveClientInformation(clientInformation) {
      oauth.clientInformation = clientInformation;
      await updateOAuth({ clientInformation });
    },
    tokens() { return oauth.tokens; },
    async saveTokens(tokens) {
      oauth.tokens = tokens;
      await updateOAuth({ tokens });
    },
    async redirectToAuthorization(authorizationUrl) {
      if (typeof providerConfig.openAuthorizationUrl === 'function') {
        await providerConfig.openAuthorizationUrl(String(authorizationUrl));
        return;
      }
      throw new Error(`MCP OAuth authorization required: ${authorizationUrl}`);
    },
    async saveCodeVerifier(nextCodeVerifier) {
      codeVerifier = String(nextCodeVerifier ?? '');
      oauth.codeVerifier = codeVerifier;
      await updateOAuth({ codeVerifier });
    },
    codeVerifier() {
      if (!codeVerifier) throw new Error('MCP OAuth code verifier is missing.');
      return codeVerifier;
    },
    discoveryState() { return oauth.discoveryState ?? undefined; },
    async saveDiscoveryState(discoveryState) {
      oauth.discoveryState = discoveryState;
      await updateOAuth({ discoveryState });
    },
    async invalidateCredentials(scope) {
      if (scope === 'tokens' || scope === 'all') {
        oauth.tokens = undefined;
        await updateOAuth({ tokens: null });
      }
      if (scope === 'client' || scope === 'all') {
        oauth.clientInformation = undefined;
        await updateOAuth({ clientInformation: null });
      }
      if (scope === 'discovery' || scope === 'all') {
        oauth.discoveryState = undefined;
        await updateOAuth({ discoveryState: null });
      }
    },
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
  const transportOptions = { requestInit };
  const authProvider = createOAuthProvider(config);
  if (authProvider) transportOptions.authProvider = authProvider;
  if (config.transport === 'sse') {
    return new SSEClientTransport(new URL(config.url), transportOptions);
  }
  return new StreamableHTTPClientTransport(new URL(config.url), transportOptions);
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
    const title = typeof info.title === 'string' ? info.title.trim() : '';
    const version = typeof info.version === 'string' ? info.version.trim() : '';
    if (!name && !title && !version) return undefined;
    return {
      ...(name ? { name } : {}),
      ...(title ? { title } : {}),
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

function errorMessage(error) {
  return error?.message ?? String(error);
}

function isAuthRequiredError(error) {
  const message = errorMessage(error).toLowerCase();
  const status = error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.cause?.status ?? error?.cause?.statusCode;
  if (status === 401 || status === 403) return true;
  return message.includes('401')
    || message.includes('403')
    || message.includes('unauthorized')
    || message.includes('forbidden')
    || message.includes('authorization required')
    || message.includes('authentication required')
    || message.includes('invalid_token')
    || message.includes('www-authenticate');
}

function authRequiredProbe(error) {
  const message = errorMessage(error);
  return {
    state: 'needs_auth',
    ok: false,
    health: {
      status: 'failed',
      checkedAt: nowIso(),
      message,
    },
    toolsCount: 0,
    resourcesCount: 0,
    promptsCount: 0,
    auth: {
      type: 'oauth',
      message: '此 MCP 服务要求身份验证。',
    },
    message,
    errors: [{ kind: 'auth', message }],
  };
}

export async function probeMcpConnection(server, options = {}) {
  try {
    const manifest = await discoverMcpManifest(server, options);
    return {
      state: manifest.health.status === 'failed' ? 'failed' : 'connected',
      ok: manifest.health.status !== 'failed',
      manifest,
      health: manifest.health,
      toolsCount: manifest.tools.length,
      resourcesCount: manifest.resources.length,
      promptsCount: manifest.prompts.length,
      errors: manifest.errors,
    };
  } catch (error) {
    if (isAuthRequiredError(error)) return authRequiredProbe(error);
    const message = errorMessage(error);
    return {
      state: 'failed',
      ok: false,
      health: {
        status: 'failed',
        checkedAt: nowIso(),
        message,
      },
      toolsCount: 0,
      resourcesCount: 0,
      promptsCount: 0,
      message,
      errors: [{ kind: 'connection', message }],
    };
  }
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

export async function startMcpOAuth(server, options = {}) {
  const config = await prepareServerConfig(server, options);
  if (config.transport === 'stdio') {
    throw new Error('MCP_OAUTH_UNSUPPORTED_TRANSPORT');
  }
  if (config.__authContext?.mode !== 'oauth2') {
    throw new Error('MCP_OAUTH_NOT_CONFIGURED');
  }
  if (!config.url) throw new Error('MCP HTTP server requires url.');
  const provider = createOAuthProvider(config);
  if (!provider) {
    // 进入这里说明 oauth2 模式下凭据/Provider 配置缺失，给出可读错误而非静默无认证。
    throw new Error('MCP_OAUTH_NOT_CONFIGURED');
  }
  if (typeof provider.redirectToAuthorization !== 'function') {
    throw new Error('MCP_OAUTH_NO_BROWSER');
  }
  // auth() 会按 MCP Authorization 规范发现授权服务器 / 受保护资源元数据，必要时执行动态
  // 注册，生成 PKCE code_verifier（通过 provider.saveCodeVerifier 持久化），随后调用
  // provider.redirectToAuthorization 打开系统浏览器。返回值：
  //   'AUTHORIZED' —— 已有有效 token（或刷新成功），无需浏览器交互。
  //   'REDIRECT'   —— 已打开浏览器，等待 loopback 回调拿 code 再交换 token。
  let result;
  try {
    result = await auth(provider, { serverUrl: config.url });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      // SDK 在无法完成发现/注册时抛出 UnauthorizedError；归一成可读错误码。
      throw new Error('MCP_OAUTH_DISCOVERY_FAILED');
    }
    throw error;
  }
  return {
    status: result === 'AUTHORIZED' ? 'authorized' : 'redirect',
    redirected: result !== 'AUTHORIZED',
  };
}

export async function finishMcpOAuth(server, authorizationCode, options = {}) {
  const code = typeof authorizationCode === 'string' ? authorizationCode.trim() : '';
  if (!code) throw new Error('MCP OAuth authorization code is required.');
  const config = await prepareServerConfig(server, options);
  const transport = createTransport(config);
  if (typeof transport?.finishAuth !== 'function') {
    throw new Error('MCP transport does not support OAuth finishAuth.');
  }
  await transport.finishAuth(code);
  try { await transport.close?.(); } catch {}
  return { ok: true };
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
  isAuthRequiredError,
};
