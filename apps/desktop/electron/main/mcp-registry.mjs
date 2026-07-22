import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathOf } from './data-store.mjs';

const VERSION = 1;
const DEFAULT_POLICY = Object.freeze({
  trusted: true,
  visibleByDefault: true,
  requirePermission: true,
  maxRiskLevel: 'L4_privileged',
});

function nowIso() {
  return new Date().toISOString();
}

function defaultRegistryPath() {
  return pathOf('mcpRegistry');
}

function ensureParent(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  ensureParent(filePath);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => typeof item === 'string'),
  );
}

function normalizeCredentialRef(value) {
  const ref = asString(value).trim();
  if (!ref) return '';
  return ref.startsWith('mcp-cred:') ? ref : `mcp-cred:${ref}`;
}

function normalizeHeaderName(value) {
  const headerName = asString(value).trim();
  if (!headerName) return '';
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName)) throw new Error('Invalid MCP auth header name.');
  return headerName;
}

function normalizeEnvName(value) {
  const envName = asString(value).trim();
  if (!envName) return '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new Error('Invalid MCP auth env name.');
  return envName;
}

function normalizeAuthBinding(auth = {}) {
  const mode = asString(auth?.mode).trim() || 'none';
  if (mode === 'none') return { mode: 'none' };
  if (!['http_bearer', 'http_header', 'stdio_env', 'oauth2'].includes(mode)) throw new Error(`Unsupported MCP auth mode: ${mode}`);
  const credentialRef = normalizeCredentialRef(auth.credentialRef);
  if (!credentialRef) throw new Error(`MCP auth mode ${mode} requires credentialRef.`);
  const binding = { mode, credentialRef };
  if (mode === 'http_header') {
    binding.headerName = normalizeHeaderName(auth.headerName);
    if (!binding.headerName) throw new Error('MCP http_header auth requires headerName.');
  }
  if (mode === 'stdio_env') {
    binding.envName = normalizeEnvName(auth.envName);
    if (!binding.envName) throw new Error('MCP stdio_env auth requires envName.');
  }
  return binding;
}

export function slugifyMcpId(value) {
  const base = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || `mcp-${randomUUID().slice(0, 8)}`;
}

function normalizeLegacyItem(item = {}) {
  const id = String(item.id ?? item.mcpId ?? slugifyMcpId(item.name ?? item.serverUrl ?? randomUUID()));
  const transport = item.transport === 'stdio' ? 'stdio' : item.transport === 'sse' ? 'sse' : 'streamable_http';
  const url = asString(item.url ?? item.serverUrl, '');
  return {
    id,
    mcpId: id,
    displayName: asString(item.displayName ?? item.name, id),
    name: asString(item.displayName ?? item.name, id),
    reportedName: item.reportedName ? asString(item.reportedName) : null,
    reportedTitle: item.reportedTitle ? asString(item.reportedTitle) : null,
    reportedVersion: item.reportedVersion ? asString(item.reportedVersion) : null,
    description: asString(item.description, ''),
    enabled: item.enabled !== false,
    transport,
    command: asString(item.command, ''),
    args: asStringArray(item.args),
    cwd: item.cwd ? asString(item.cwd) : null,
    url,
    serverUrl: url,
    headers: asRecord(item.headers),
    env: asRecord(item.env),
    envSecretRefs: asRecord(item.envSecretRefs),
    auth: normalizeAuthBinding(item.auth),
    policy: {
      ...DEFAULT_POLICY,
      ...(item.policy && typeof item.policy === 'object' ? item.policy : {}),
    },
    toolVisibility: item.toolVisibility && typeof item.toolVisibility === 'object' ? item.toolVisibility : {},
    tools: Array.isArray(item.tools) ? item.tools : [],
    resources: Array.isArray(item.resources) ? item.resources : [],
    prompts: Array.isArray(item.prompts) ? item.prompts : [],
    health: item.health && typeof item.health === 'object'
      ? item.health
      : { status: 'unknown', checkedAt: null, message: '' },
    manifestUpdatedAt: item.manifestUpdatedAt ?? item.updatedAt ?? null,
    lastError: item.lastError ?? null,
    createdAt: item.createdAt ?? nowIso(),
    updatedAt: item.updatedAt ?? nowIso(),
  };
}

function normalizeRegistry(data) {
  if (Array.isArray(data)) {
    return { version: VERSION, servers: data.map(normalizeLegacyItem) };
  }
  const servers = Array.isArray(data?.servers) ? data.servers.map(normalizeLegacyItem) : [];
  return { version: VERSION, servers };
}

function toRendererView(server) {
  const tools = Array.isArray(server.tools) ? server.tools : [];
  const resources = Array.isArray(server.resources) ? server.resources : [];
  const prompts = Array.isArray(server.prompts) ? server.prompts : [];
  const visibleToolsCount = tools.filter((tool) => server.toolVisibility?.[tool.name ?? tool.toolName] !== false).length;
  return {
    id: server.id,
    mcpId: server.id,
    displayName: server.displayName,
    name: server.displayName,
    reportedName: server.reportedName ?? null,
    reportedTitle: server.reportedTitle ?? null,
    reportedVersion: server.reportedVersion ?? null,
    description: server.description,
    enabled: server.enabled,
    transport: server.transport,
    commandPreview: server.transport === 'stdio' ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') : '',
    urlPreview: server.transport === 'streamable_http' ? server.url : '',
    serverUrl: server.transport === 'streamable_http' ? server.url : '',
    auth: server.auth?.mode === 'none'
      ? { mode: 'none' }
      : {
        mode: server.auth?.mode,
        credentialRef: server.auth?.credentialRef,
        ...(server.auth?.headerName ? { headerName: server.auth.headerName } : {}),
        ...(server.auth?.envName ? { envName: server.auth.envName } : {}),
      },
    toolsCount: tools.length,
    visibleToolsCount,
    resourcesCount: resources.length,
    promptsCount: prompts.length,
    tools: tools.map((tool) => ({
      name: tool.name ?? tool.toolName,
      toolName: tool.name ?? tool.toolName,
      description: tool.description ?? tool.toolDesc ?? '',
      toolDesc: tool.description ?? tool.toolDesc ?? '',
      visible: server.toolVisibility?.[tool.name ?? tool.toolName] !== false,
      inputSchema: tool.inputSchema ?? {},
    })),
    resources: resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name ?? resource.uri,
      description: resource.description ?? '',
      mimeType: resource.mimeType ?? '',
    })),
    prompts: prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description ?? '',
      arguments: prompt.arguments ?? [],
    })),
    health: server.health ?? { status: 'unknown', checkedAt: null, message: '' },
    manifestUpdatedAt: server.manifestUpdatedAt ?? null,
    lastError: server.lastError ?? null,
    policy: {
      trusted: server.policy?.trusted !== false,
      requirePermission: server.policy?.requirePermission !== false,
      visibleByDefault: server.policy?.visibleByDefault !== false,
      maxRiskLevel: server.policy?.maxRiskLevel ?? DEFAULT_POLICY.maxRiskLevel,
    },
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

export function createMcpRegistry({ registryPath = defaultRegistryPath() } = {}) {
  function readRegistry() {
    return normalizeRegistry(readJsonFile(registryPath, { version: VERSION, servers: [] }));
  }

  function writeRegistry(registry) {
    writeJsonFile(registryPath, normalizeRegistry(registry));
  }

  function listServers() {
    return readRegistry().servers;
  }

  function listInstalled() {
    return listServers().map(toRendererView);
  }

  function getServer(serverId) {
    const id = String(serverId ?? '');
    return listServers().find((server) => server.id === id || String(server.mcpId) === id) ?? null;
  }

  function upsertServer(config = {}) {
    const registry = readRegistry();
    const id = String(config.id ?? config.mcpId ?? slugifyMcpId(config.displayName ?? config.name ?? config.url ?? config.serverUrl));
    const index = registry.servers.findIndex((server) => server.id === id || server.mcpId === id);
    const previous = index >= 0 ? registry.servers[index] : null;
    const server = normalizeLegacyItem({
      ...previous,
      ...config,
      id,
      mcpId: id,
      updatedAt: nowIso(),
      createdAt: previous?.createdAt ?? nowIso(),
    });
    if (index >= 0) registry.servers[index] = server;
    else registry.servers.push(server);
    writeRegistry(registry);
    return toRendererView(server);
  }

  function install(item) {
    return upsertServer(item);
  }

  function uninstall(serverId) {
    const id = String(serverId ?? '');
    const registry = readRegistry();
    const servers = registry.servers.filter((server) => server.id !== id && String(server.mcpId) !== id);
    writeRegistry({ ...registry, servers });
    return servers.map(toRendererView);
  }

  function setEnabled(serverId, enabled) {
    const server = getServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    return upsertServer({ ...server, enabled: Boolean(enabled) });
  }

  function setToolVisibility(serverId, toolName, visible) {
    const server = getServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    const name = String(toolName ?? '');
    if (!name) throw new Error('toolName is required');
    return upsertServer({
      ...server,
      toolVisibility: {
        ...(server.toolVisibility ?? {}),
        [name]: Boolean(visible),
      },
    });
  }

  function updateManifest(serverId, manifest) {
    const server = getServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    const reportedName = asString(manifest?.serverInfo?.name ?? '').trim();
    const reportedTitle = asString(manifest?.serverInfo?.title ?? '').trim();
    const reportedVersion = asString(manifest?.serverInfo?.version ?? '').trim();
    // Prefer the server-reported human title when available, then fall back to the
    // protocol name. This ensures Refresh Manifest keeps the displayed title in
    // sync with the MCP server without using local auto-fallback heuristics.
    const nextDisplayName = reportedTitle || reportedName || server.displayName;
    const next = upsertServer({
      ...server,
      displayName: nextDisplayName,
      name: nextDisplayName,
      reportedName: reportedName || server.reportedName || null,
      reportedTitle: reportedTitle || server.reportedTitle || null,
      reportedVersion: reportedVersion || server.reportedVersion || null,
      tools: Array.isArray(manifest?.tools) ? manifest.tools : [],
      resources: Array.isArray(manifest?.resources) ? manifest.resources : [],
      prompts: Array.isArray(manifest?.prompts) ? manifest.prompts : [],
      health: manifest?.health ?? { status: 'ok', checkedAt: nowIso(), message: '' },
      manifestUpdatedAt: nowIso(),
      lastError: null,
    });
    return next;
  }

  function updateHealth(serverId, health) {
    const server = getServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    return upsertServer({
      ...server,
      health: {
        status: health?.status ?? 'unknown',
        checkedAt: health?.checkedAt ?? nowIso(),
        message: health?.message ?? '',
      },
      lastError: health?.status === 'failed' ? health?.message ?? 'MCP health check failed' : null,
    });
  }

  function listCapabilityManifests() {
    const servers = listServers();
    const manifests = [];
    for (const server of servers) {
      if (server.enabled === false) continue;
      if (server.policy?.trusted === false) continue;
      if (server.health?.status === 'failed') continue;
      for (const tool of server.tools ?? []) {
        const toolName = tool.name ?? tool.toolName;
        if (!toolName) continue;
        const visible = server.toolVisibility?.[toolName] ?? server.policy?.visibleByDefault ?? true;
        if (!visible) continue;
        // Health is derived from the live server state + permission policy.
        // `failed` servers are already filtered out above, so a reachable tool is
        // either ready to use (`available`) or gated behind a permission prompt
        // (`needs_permission`). Previously this field was omitted entirely, which
        // made the renderer fall back to `unavailable` for every MCP capability.
        const requiresPermission = server.policy?.requirePermission !== false;
        const health = requiresPermission ? 'needs_permission' : 'available';
        manifests.push({
          capabilityId: `local.mcp.${server.id}.${toolName}`,
          name: `mcp__${server.id.replace(/[^a-zA-Z0-9_-]/g, '_')}__${String(toolName).replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          displayName: `${server.displayName}: ${toolName}`,
          description: tool.description ?? tool.toolDesc ?? `MCP tool ${toolName} from ${server.displayName}.`,
          source: 'mcp',
          locality: 'local',
          health,
          providerId: server.id,
          providerLabel: server.displayName,
          riskLevel: tool.riskLevel ?? 'L3_external_write',
          dataLevel: tool.dataLevel ?? 'D2_sensitive',
          inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
            ? tool.inputSchema
            : { type: 'object', additionalProperties: true },
          permissionPolicy: {
            kind: 'mcp-tool',
            required: server.policy?.requirePermission !== false,
          },
          runtime: {
            executor: 'local-tool-host',
            executorCapabilityId: `local.mcp.${server.id}.${toolName}`,
          },
          origin: {
            providerId: server.id,
            transport: server.transport,
            toolName,
            authMode: server.auth?.mode ?? 'none',
            hasCredential: Boolean(server.auth?.credentialRef),
          },
        });
      }
    }
    return manifests;
  }

  return {
    listServers,
    listInstalled,
    getServer,
    upsertServer,
    install,
    uninstall,
    setEnabled,
    setToolVisibility,
    updateManifest,
    updateHealth,
    listCapabilityManifests,
    // 暴露注册表真实路径（只读），供 mcp-host prompt source 注入自我认知（B2b）。
    path: registryPath,
  };
}
