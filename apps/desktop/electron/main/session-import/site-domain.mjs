/**
 * 站点域名聚合（MVP）：
 * 用简化 eTLD+1 规则做 Cookie host_key 归并。
 * 完整 Public Suffix List 可后续替换，接口保持 getRegistrableDomain。
 */

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.cn',
  'net.cn',
  'org.cn',
  'com.au',
  'net.au',
  'org.au',
  'com.br',
  'com.mx',
  'co.kr',
  'com.hk',
  'com.tw',
  'com.sg',
]);

/** 去掉 host_key 前导点，并小写化。 */
export function normalizeHostKey(hostKey) {
  const raw = String(hostKey || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '');
  return raw;
}

/**
 * 简化 eTLD+1：
 * - example.com → example.com
 * - www.example.com → example.com
 * - foo.co.uk → foo.co.uk
 * - notexample.com 不会匹配 example.com
 */
export function getRegistrableDomain(hostKey) {
  const host = normalizeHostKey(hostKey);
  if (!host || host.includes('://') || host.includes('/')) return null;
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;

  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return host;

  const last2 = parts.slice(-2).join('.');
  if (MULTI_PART_PUBLIC_SUFFIXES.has(last2) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return last2;
}

/** host 是否属于选定的 registrable domain（含子域，不含旁名）。 */
export function hostBelongsToRegistrableDomain(hostKey, registrableDomain) {
  const host = normalizeHostKey(hostKey);
  const root = normalizeHostKey(registrableDomain);
  if (!host || !root) return false;
  return host === root || host.endsWith(`.${root}`);
}
