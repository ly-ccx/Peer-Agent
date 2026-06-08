import { net } from 'electron';

const DEFAULT_TIMEOUT_MS = 20000;
const DINGTALK_AIHUB_BASE = 'https://aihub.dingtalk.com';

function buildUrl(gatewayUrl, pathname) {
  return `${gatewayUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function createTimeoutSignal(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('MCP market request timed out.')), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function readJson(response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json?.error || json?.errorCode) {
    const message = json?.error_description ?? json?.errorMsg ?? json?.error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return json;
}

async function fetchDingtalkJson(url) {
  const timeout = createTimeoutSignal();
  try {
    const response = await net.fetch(url, {
      headers: { Accept: 'application/json' },
      signal: timeout.signal,
    });
    const payload = await response.json();
    if (!payload?.success) {
      throw new Error(payload?.errorMsg || 'DingTalk API request failed');
    }
    return payload;
  } finally {
    timeout.clear();
  }
}

async function fetchDingtalkMarketPages(buildPageUrl) {
  const firstPayload = await fetchDingtalkJson(buildPageUrl(1));
  const result = firstPayload?.result || {};
  const totalPages = Math.max(Number(result?.totalPages) || 1, 1);
  const allValues = Array.isArray(result?.values) ? [...result.values] : [];

  for (let page = 2; page <= Math.min(totalPages, 5); page += 1) {
    const payload = await fetchDingtalkJson(buildPageUrl(page));
    const values = Array.isArray(payload?.result?.values) ? payload.result.values : [];
    allValues.push(...values);
  }
  return allValues;
}

function isAuthRequiredError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes('BUC sign-in is required') ||
    message.includes('HTTP 401') ||
    message.includes('Unauthorized') ||
    message.includes('未登录') ||
    message.includes('授权')
  );
}

function normalizeDingtalkSearchList(values) {
  const merged = new Map();
  values.forEach((item) => {
    const mcpId = Number(item?.mcpId || item?.toolId);
    const name = String(item?.name || '').trim();
    if (!Number.isFinite(mcpId) || mcpId <= 0 || !name || merged.has(mcpId)) return;
    merged.set(mcpId, {
      mcpId,
      name,
      description: String(item?.description || '').trim() || undefined,
      icon: String(item?.icon || '').trim() || undefined,
      providerCorpName: String(item?.providerCorpName || item?.corpName || '').trim() || undefined,
    });
  });
  return Array.from(merged.values());
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function extractAoneMarketValues(result) {
  const data = result?.data;
  const resultValue = result?.result;
  return firstArray(
    data?.list,
    data?.values,
    data?.records,
    data?.items,
    data?.data,
    resultValue?.list,
    resultValue?.values,
    resultValue?.records,
    resultValue?.items,
    resultValue?.data,
    data,
    resultValue,
    result?.list,
    result?.values,
    result?.records,
    result?.items,
  );
}

import { createHash } from 'node:crypto';

const AONE_MCP_GATEWAY = 'https://gateway.aone.alibaba-inc.com/aone/open/open-api/mcp/servers';
const AONE_AGW_CLIENT = 'cbu-xiaoer-node-service.default.primary';
const AONE_AGW_SECRET = 'di4p5uuj1phj0e8i2ppaeeevm232uq94';

function buildAoneGatewayAuth() {
  const timestamp = String(Date.now());
  const signature = createHash('sha256').update(`${timestamp}\n${AONE_AGW_SECRET}`).digest('hex');
  return { 'AGW-Client': AONE_AGW_CLIENT, 'AGW-Signature': signature, 'AGW-Timestamp': timestamp };
}

export function createMcpMarketService({ getAccessToken, getEndpointConfig }) {
  async function buildHeaders() {
    const token = await getAccessToken();
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-zeus-atlas-client': 'desktop',
    };
  }

  async function listAoneMarket(params = {}) {
    const keyword = String(params.keyword || '').trim();
    const offset = Number(params.offset) || 0;
    const limit = Number(params.limit) || 50;
    const resourceType = params.resourceType || 'skill';
    const queryParams = new URLSearchParams({
      resourceType,
      offset: String(offset),
      limit: String(limit),
    });
    if (keyword) queryParams.set('keyword', keyword);
    const timeout = createTimeoutSignal();
    try {
      const url = `https://contextlab.alibaba-inc.com/api/resources?${queryParams.toString()}`;
      console.log('[contextlab] fetching:', url);
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: timeout.signal,
      });
      const text = await response.text();
      console.log('[contextlab] status:', response.status, 'body:', text.slice(0, 200));
      const data = JSON.parse(text);
      const items = Array.isArray(data?.data) ? data.data : [];
      console.log('[contextlab] items:', items.length);
      return { list: items.map(normalizeAoneItem).filter(Boolean) };
    } finally {
      timeout.clear();
    }
  }

  async function listAoneMcpServers(params = {}) {
    const keyword = String(params.keyword || '').trim();
    const page = Number(params.page) || 1;
    const pageSize = Number(params.pageSize) || 50;
    const clientId = String(params.clientId || '').trim();
    const empId = String(params.empId || '').trim();
    const auth = buildAoneGatewayAuth();
    const queryParams = new URLSearchParams({
      client_id: clientId || '123',
      page: String(page),
      pageSize: String(pageSize),
      order_by: 'USAGE',
      'AGW-Client': auth['AGW-Client'],
      'AGW-Signature': auth['AGW-Signature'],
      'AGW-Timestamp': auth['AGW-Timestamp'],
    });
    if (empId) queryParams.set('emp_id', empId);
    if (keyword) queryParams.set('keyword', keyword);
    const timeout = createTimeoutSignal();
    try {
      const url = `${AONE_MCP_GATEWAY}?${queryParams.toString()}`;
      console.log('[aone-mcp] fetching:', url);
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: timeout.signal,
      });
      const text = await response.text();
      console.log('[aone-mcp] status:', response.status, 'body:', text.slice(0, 200));
      const data = JSON.parse(text);
      const items = Array.isArray(data?.content) ? data.content : [];
      return {
        list: items.map(normalizeAoneMcpItem).filter(Boolean),
        total: Number(data?.totalElements) || 0,
      };
    } finally {
      timeout.clear();
    }
  }

  async function requestJson(pathname, body) {
    const config = getEndpointConfig();
    const url = buildUrl(config.gatewayUrl, pathname);
    const timeout = createTimeoutSignal();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: await buildHeaders(),
        body: JSON.stringify(body ?? {}),
        signal: timeout.signal,
      });
      return await readJson(response);
    } finally {
      timeout.clear();
    }
  }

  async function listInstalledMcp(params = {}) {
    const result = await requestJson(
      '/api/xiaoerAiApi/unifiedServices/getAllUnifiedServices/authenticated',
      { args: [{ serviceType: 'MCP', workid: params.workId, pageSize: 200, pageNo: 1 }] },
    );
    const list = result?.data?.list ?? [];
    return list.map(normalizeInstalledItem);
  }

  async function listDingtalkMarket(params = {}) {
    const pageSize = Math.min(Math.max(Number(params.pageSize) || 50, 1), 100);
    const keyword = String(params.keyword || '').trim();
    const search = keyword ? `&search=${encodeURIComponent(keyword)}` : '';

    const values = await fetchDingtalkMarketPages(
      (page) => `${DINGTALK_AIHUB_BASE}/mcp/market/search?page=${page}&pageSize=${pageSize}${search}`,
    );
    return normalizeDingtalkSearchList(values);
  }

  async function getDingtalkDetail(params = {}) {
    const mcpId = Number(params.mcpId);
    if (!Number.isFinite(mcpId) || mcpId <= 0) return null;
    const payload = await fetchDingtalkJson(`${DINGTALK_AIHUB_BASE}/mcp/market/detail?mcpId=${mcpId}`);
    const result = payload?.result;
    if (!result) return null;
    const tools = Array.isArray(result.tools)
      ? result.tools.map((t) => ({
        toolName: String(t?.toolName || '').trim(),
        toolDesc: String(t?.toolDesc || '').trim() || undefined,
      }))
      : [];
    return {
      mcpId: Number(result.mcpId) || 0,
      name: String(result.name || '').trim(),
      description: String(result.description || '').trim() || undefined,
      icon: String(result.icon || '').trim() || undefined,
      providerCorpName: String(result.providerCorpName || '').trim() || undefined,
      introduction: String(result.introduction || '').trim() || undefined,
      tools,
    };
  }

  async function probeMcpServer(params = {}) {
    const result = await requestJson(
      '/api/xiaoerAiApi/unifiedServices/probeMcpServer/authenticated',
      { args: [{ serverUrl: params.serverUrl, workId: params.workId, serviceId: params.serviceId }] },
    );
    return result?.data ?? null;
  }

  async function getAoneMcpServerDetail(params = {}) {
    const serverName = String(params.serverName || '').trim();
    if (!serverName) return null;
    const auth = buildAoneGatewayAuth();
    const queryParams = new URLSearchParams({
      env: params.env || 'prod',
      'AGW-Client': auth['AGW-Client'],
      'AGW-Signature': auth['AGW-Signature'],
      'AGW-Timestamp': auth['AGW-Timestamp'],
    });
    const timeout = createTimeoutSignal();
    try {
      const url = `${AONE_MCP_GATEWAY}/${encodeURIComponent(serverName)}?${queryParams.toString()}`;
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: timeout.signal,
      });
      const data = await response.json();
      if (!data?.name && !data?.displayName) return null;
      return {
        name: data.name,
        displayName: data.displayName,
        description: data.description,
        icon: data.avatarUrl,
        readme: data.readme,
        status: data.status,
        type: data.type,
        creator: data.creator,
        tools: (data.tools || []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      };
    } finally {
      timeout.clear();
    }
  }

  return { listInstalledMcp, listDingtalkMarket, listAoneMarket, listAoneMcpServers, getAoneMcpServerDetail, getDingtalkDetail, probeMcpServer };
}

function normalizeInstalledItem(row) {
  const config = typeof row.serviceConfig === 'string'
    ? safeParseJson(row.serviceConfig)
    : (row.serviceConfig ?? {});
  const tools = Array.isArray(config.tools) ? config.tools : [];
  const sourceType = config.sourceType ?? 'custom';
  const authType = config.authType ?? 'none';

  return {
    serviceId: row.id,
    name: row.name ?? row.description ?? `MCP #${row.id}`,
    description: row.description ?? '',
    sourceType,
    authType,
    authStatus: row.mcpAuthStatus?.authorized ? 'authorized' : (row.mcpAuthStatus?.expired ? 'expired' : 'none'),
    toolCount: tools.length,
    tools: tools.map((t) => ({ name: t.toolName ?? t.name ?? '', description: t.toolDesc ?? t.description ?? '' })),
    serverUrl: config.serverUrl ?? '',
    providerName: config.dingtalkMarket?.providerCorpName ?? '',
    dingtalkMarket: config.dingtalkMarket ? {
      mcpId: config.dingtalkMarket.mcpId ?? config.dingtalkMarket.marketMcpId,
      name: config.dingtalkMarket.name ?? '',
      icon: config.dingtalkMarket.icon ?? '',
    } : undefined,
  };
}

function normalizeAoneItem(item) {
  if (!item) return null;
  const name = String(item.resourceName || item.name || '').trim();
  if (!name) return null;
  return {
    id: String(item.resourceId || ''),
    name,
    description: String(item.description || '').trim() || undefined,
    provider: String(item.source || '').replace(/^(skill|plugin):/, '') || undefined,
    source: 'aone',
    resourceType: item.resourceType,
    latestVersion: item.latestVersion,
    tarballUrl: item.tarballUrl,
    fileUrl: item.fileUrl,
  };
}

function normalizeAoneMcpItem(item) {
  if (!item) return null;
  const name = String(item.name || item.code || '').trim();
  if (!name) return null;
  return {
    code: String(item.code || '').trim(),
    name,
    description: String(item.description || '').trim() || undefined,
    icon: String(item.icon || '').trim() || undefined,
    ownerEmpId: item.ownerEmpId,
    platformCode: item.platformCode,
    usageCount: Number(item.usageCount) || 0,
    toolsCount: Number(item.toolsCount) || 0,
    mcpType: item.mcpType,
  };
}

function safeParseJson(value) {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}
