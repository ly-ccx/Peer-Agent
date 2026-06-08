import { BrowserWindow, net, session } from 'electron';

const DEFAULT_TIMEOUT_MS = 20000;
const DINGTALK_AIHUB_BASE = 'https://aihub.dingtalk.com';
const AONE_MARKET_BASE = 'https://open.aone.alibaba-inc.com';
const AONE_SSO_CHECK_URL = `${AONE_MARKET_BASE}/api/market/search?types=AGENT_SKILL&pn=1&rn=1&status=OPEN&orderBy=USAGE&log=true`;

function createTimeoutSignal(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Skill market request timed out.')), timeoutMs);
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
    const response = await fetch(url, {
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

/**
 * 检查 Electron session 是否已有 Aone SSO cookie（快速探测）。
 */
export async function hasAoneSsoCookie() {
  const cookies = await session.defaultSession.cookies.get({ domain: '.alibaba-inc.com' });
  // 有任意一个常见 SSO cookie 就认为有效
  return cookies.some((c) => ['cookie2', 'cookie71', 'JSESSIONID', '_sso_token', 'cna'].includes(c.name));
}

/**
 * 打开 BrowserWindow 让用户在应用内完成 Aone SSO 登录。
 * 登录成功后 Electron session 会获得 SSO cookie。
 */
export function loginAone(targetUrl = AONE_MARKET_BASE) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 800,
      height: 650,
      title: 'Aone 内网登录',
      show: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    let settled = false;
    const settle = (fn) => { if (!settled) { settled = true; fn(); } };

    // 监听导航：如果回到了 Aone 域名（非 login 页面），说明登录成功
    win.webContents.on('did-navigate', (_e, navUrl) => {
      console.log('[skill-market] SSO navigate →', navUrl);
      if (navUrl.startsWith(AONE_MARKET_BASE) && !navUrl.includes('/login')) {
        settle(() => { win.close(); resolve(true); });
      }
    });

    win.on('closed', () => {
      settle(() => reject(new Error('用户取消了内网登录')));
    });

    // 超时 3 分钟
    setTimeout(() => {
      settle(() => { win.close(); reject(new Error('内网登录超时')); });
    }, 180000);

    win.loadURL(targetUrl);
  });
}

export function createSkillMarketService({ getAccessToken, downloadDingtalkFile }) {

  async function requestAoneJson(url) {
    const timeout = createTimeoutSignal();
    try {
      const response = await net.fetch(url, {
        headers: { Accept: 'application/json' },
        signal: timeout.signal,
      });
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        // 返回 HTML（SSO 登录页），打开窗口让用户登录
        await loginAone(url);
        // 登录成功后重试一次
        const retryResponse = await net.fetch(url, {
          headers: { Accept: 'application/json' },
          signal: timeout.signal,
        });
        const retryContentType = retryResponse.headers.get('content-type') || '';
        if (!retryContentType.includes('application/json')) {
          throw new Error('AONE_SSO_REQUIRED');
        }
        return await readJson(retryResponse);
      }
      return await readJson(response);
    } finally {
      timeout.clear();
    }
  }

  async function listDingtalkSkillMarket(params = {}) {
    const page = Math.max(Number(params.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(params.pageSize) || 12, 1), 100);
    const keyword = String(params.keyword || '').trim();
    const search = keyword ? `&search=${encodeURIComponent(keyword)}` : '';
    const url = `${DINGTALK_AIHUB_BASE}/aibase/market/skill/list?page=${page}&pageSize=${pageSize}${search}`;
    const payload = await fetchDingtalkJson(url);
    const result = payload?.result || {};
    return {
      currentPage: Number(result.currentPage) || page,
      pageSize: Number(result.pageSize) || pageSize,
      totalCount: Number(result.totalCount) || 0,
      totalPages: Number(result.totalPages) || 0,
      values: normalizeSkillMarketList(Array.isArray(result.values) ? result.values : []),
    };
  }

  async function listAoneSkillMarket(params = {}) {
    const offset = ((Math.max(Number(params.pn) || 1, 1)) - 1) * Math.min(Math.max(Number(params.rn) || 12, 1), 100);
    const limit = Math.min(Math.max(Number(params.rn) || 12, 1), 100);
    const keyword = String(params.keyword || '').trim();
    const queryParams = new URLSearchParams({
      resourceType: 'skill',
      empId: 'anonymous',
      offset: String(offset),
      limit: String(limit),
    });
    if (keyword) queryParams.set('keyword', keyword);
    const url = `https://contextlab.alibaba-inc.com/api/resources?${queryParams.toString()}`;
    const timeout = createTimeoutSignal();
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: timeout.signal,
      });
      const data = await response.json();
      const items = Array.isArray(data?.data) ? data.data : [];
      return {
        pn: Math.max(Number(params.pn) || 1, 1),
        rn: limit,
        total: Number(data?.total) || 0,
        totalPages: Math.ceil((Number(data?.total) || 0) / limit),
        items: items.map((item) => ({
          id: String(item?.resourceId || ''),
          name: String(item?.resourceName || '').trim(),
          description: String(item?.description || '').trim() || undefined,
          source: String(item?.source || '').replace(/^skill:/, ''),
          latestVersion: item?.latestVersion,
          tarballUrl: item?.tarballUrl,
        })).filter((item) => item.name),
      };
    } finally {
      timeout.clear();
    }
  }

  async function ensureAoneAuth() {
    return { status: 'ready' };
    if (await hasAoneSsoCookie()) return { status: 'ready' };
    // 快速探测一次
    try {
      const res = await net.fetch(AONE_SSO_CHECK_URL, { headers: { Accept: 'application/json' } });
      if ((res.headers.get('content-type') || '').includes('application/json')) {
        return { status: 'ready' };
      }
    } catch { /* ignore */ }
    return { status: 'login_required' };
  }

  /**
   * 获取 Aone skill 详情 → 拼接 tarball URL → 下载 .tgz → 返回 Buffer。
   */
  async function installAoneSkill(skillName, options = {}) {
    let latestVersion = options?.latestVersion;
    let tarballUrlTemplate = options?.tarballUrl;
    if (!tarballUrlTemplate) {
      if (!skillName) throw new Error('skillName is required');
      const detailUrl = `${AONE_MARKET_BASE}/api/skills/v2/query-detail?name=${encodeURIComponent(skillName)}`;
      const detail = await requestAoneJson(detailUrl);

      latestVersion = detail?.['dist-tags']?.latest;
      tarballUrlTemplate = detail?.tarballUrl;
    }
    if (!latestVersion || !tarballUrlTemplate) {
      throw new Error(`无法获取 ${skillName} 的版本信息`);
    }

    const tarballUrl = tarballUrlTemplate.replace('{version}', latestVersion);
    console.log('[skill-market] downloading tarball:', tarballUrl);

    const timeout = createTimeoutSignal(60000);
    try {
      const res = await net.fetch(tarballUrl, { signal: timeout.signal });
      if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      return { buffer: Buffer.from(arrayBuffer), name: skillName, version: latestVersion };
    } finally {
      timeout.clear();
    }
  }

  /**
   * 下载钉钉市场 skill 的 zip 压缩包 → 返回 Buffer。
   * 通过 dingtalkAuth 的页面内 fetch 下载（同源请求，携带 cookie）。
   */
  async function installDingtalkSkill(skillId) {
    if (!skillId) throw new Error('skillId is required');
    const downloadUrl = `${DINGTALK_AIHUB_BASE}/aibase/market/skill/download?skillId=${encodeURIComponent(skillId)}`;
    console.log('[skill-market] downloading dingtalk skill:', downloadUrl);
    const arrayBuffer = await downloadDingtalkFile(downloadUrl);
    console.log('[skill-market] download success, size:', arrayBuffer.byteLength);
    return { buffer: Buffer.from(arrayBuffer) };
  }

  return { listDingtalkSkillMarket, listAoneSkillMarket, loginAone, ensureAoneAuth, installAoneSkill, installDingtalkSkill };
}

function normalizeSkillMarketList(values) {
  return values
    .filter((item) => item && (item.id || item.skillId))
    .map((item) => ({
      id: Number(item.id) || 0,
      skillId: String(item.skillId || ''),
      name: String(item.name || '').trim(),
      label: String(item.label || item.name || '').trim(),
      description: String(item.description || '').trim() || undefined,
      icon: String(item.icon || '').trim() || undefined,
      developerName: String(item.developerName || '').trim() || undefined,
      installCount: Number(item.installCount) || 0,
      categories: Array.isArray(item.categories) ? item.categories.map((c) => ({
        categoryCode: String(c.categoryCode || ''),
        categoryName: String(c.categoryName || ''),
      })) : [],
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      dependentServices: Array.isArray(item.dependentServices) ? item.dependentServices.map((s) => ({
        name: String(s.name || ''),
        description: String(s.description || '').trim() || undefined,
        icon: String(s.icon || '').trim() || undefined,
        toolId: Number(s.toolId) || 0,
        toolType: String(s.toolType || ''),
        charged: Boolean(s.charged),
        installed: Boolean(s.installed),
      })) : [],
    }));
}

function normalizeAoneSkillList(values) {
  return values
    .filter((item) => item && item.id)
    .map((item) => {
      const content = item.content ?? {};
      return {
        id: String(item.id || ''),
        name: String(item.name || '').trim(),
        code: String(item.code || '').trim() || undefined,
        description: String(item.description || '').trim() || undefined,
        icon: String(content.icon || item.icon || item.logoUrl || '').trim() || undefined,
        ownerEmpId: String(item.ownerEmpId || '').trim() || undefined,
        ownerName: String(item.ownerNickName || item.ownerName || '').trim() || undefined,
        favoriteCount: Number(item.favoriteCount) || 0,
        usageCount: Number(content.downloadCount || item.order) || 0,
        platformName: String(item.platformName || '').trim() || undefined,
        abilityType: String(item.abilityType || '').trim() || undefined,
      };
    });
}
