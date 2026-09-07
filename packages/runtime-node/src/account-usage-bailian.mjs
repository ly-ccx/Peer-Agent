// Best-effort API-key path verified against CodexBar's AlibabaCodingPlanUsageFetcher (MIT).
// This is a read-only query RPC, not the separate cookie-authenticated console RPC.
const origin = 'https://bailian.console.aliyun.com';
const path = '/data/api.json?' + new URLSearchParams({ action: 'zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2', product: 'broadscope-bailian', api: 'queryCodingPlanInstanceInfoV2', currentRegionId: 'cn-beijing' });
const number = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const date = (value) => {
  const n = number(value);
  const ms = n !== undefined ? (n > 1e12 ? n : n > 1e9 ? n * 1000 : NaN) : typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined;
};
const unavailable = () => [{ dimension: 'windows', reason: 'API Key 额度查询未获可用数据；该接口为 best-effort，可能需要控制台登录（不会自动读取会话）', requiredAuth: 'web_session' }];
function activeScore(row, now) {
  const status = String(row.status ?? row.instanceStatus ?? '').toUpperCase();
  if (['EXPIRED', 'INVALID', 'INACTIVE', 'DISABLED', 'TERMINATED', 'STOPPED'].includes(status) || row.isActive === false || row.active === false) return -1;
  const expiry = date(row.endTime ?? row.periodEndTime ?? row.expireTime ?? row.expirationTime);
  if (expiry && Date.parse(expiry) <= now) return -1;
  if (['VALID', 'ACTIVE'].includes(status) || row.isActive === true || row.active === true) return 3;
  return expiry ? 1 : 0;
}

export function parseBailianUsage(payload, now = Date.now()) {
  const invalid = () => ({ success: false, status: 'invalid_response', unavailable: unavailable() });
  if (!object(payload)) return invalid();
  const data = object(payload.data) ? payload.data : payload;
  for (const row of [payload, data]) {
    if (row.success === false || row.status === false || (row.status_code !== undefined && number(row.status_code) !== 0)) return invalid();
  }
  const infos = data.codingPlanInstanceInfos ?? data.coding_plan_instance_infos;
  const eligible = (Array.isArray(infos) ? infos.filter(object) : []).filter((row) => activeScore(row, now) >= 0).sort((a, b) => activeScore(b, now) - activeScore(a, now));
  // Do not attach an expired instance's nested quota or silently choose among tied accounts.
  if (Array.isArray(infos) && infos.length && !eligible.length) return invalid();
  const active = eligible.length && (eligible.length === 1 || activeScore(eligible[0], now) > activeScore(eligible[1], now)) ? eligible[0] : undefined;
  const quota = active?.codingPlanQuotaInfo ?? active?.coding_plan_quota_info ?? data.codingPlanQuotaInfo ?? data.coding_plan_quota_info;
  if (!object(quota)) return invalid();
  const windows = [];
  const absent = [];
  for (const [id, label, prefixes] of [['five-hour', '五小时', ['per5Hour', 'perFiveHour']], ['week', '周', ['perWeek']], ['month', '账单月', ['perBillMonth', 'perMonth']]]) {
    const get = (suffix) => prefixes.map((prefix) => quota[prefix + suffix]).find((value) => value !== undefined);
    const limit = number(get('TotalQuota'));
    const used = number(get('UsedQuota'));
    if (limit === undefined || used === undefined) { absent.push({ dimension: 'windows', reason: `${label}额度未返回完整计数` }); continue; }
    windows.push({ id, label, limit, used, remaining: Math.max(0, limit - used), unit: 'requests', source: 'api_key', scope: 'subscription', resetsAt: date(get('QuotaNextRefreshTime')),
      ...(limit > 0 ? { usedPercent: used / limit * 100, remainingPercent: Math.max(0, 100 - used / limit * 100) } : {}) });
  }
  if (!windows.length) return invalid();
  return { success: true, status: 'ok', partial: true, windows, unavailable: [
    { dimension: 'balance', reason: 'Coding Plan 接口不提供现金余额；API Key 查询为 best-effort' },
    { dimension: 'spend', reason: 'Coding Plan 请求额度不代表账户现金消费' }, ...absent,
  ] };
}

export const bailianUsageAdapter = {
  origin: 'https://coding.dashscope.aliyuncs.com', endpointOrigin: origin,
  path, parse: parseBailianUsage,
  request: { method: 'POST', body: JSON.stringify({ queryCodingPlanInstanceInfoRequest: { commodityCode: 'sfm_codingplan_public_cn' } }), apiKeyHeaders: ['x-api-key', 'X-DashScope-API-Key'], headers: { Origin: origin, Referer: `${origin}/cn-beijing/?tab=model#/efm/coding_plan` } },
  unavailable: unavailable(),
};
