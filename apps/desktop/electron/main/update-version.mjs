/**
 * 版本号比较（semver 子集，纯函数，无 electron 依赖）
 *
 * 为 auto 通道「beta → stable 毕业」判定提供严格的版本比较能力。
 * 毕业判定信号（ADR-61）：
 *   auto 用户当前装的是 `x.y.z-<prerelease>`，当 stable 通道出现一个
 *   版本号**严格大于**当前安装版本时，即视为该 beta 线已毕业。
 *
 * 语义遵循 semver 2.0.0 优先级规则（§11）：
 *   - 主/次/补丁号按数值比较。
 *   - 三者相等时，**带预发布标识的版本优先级低于不带预发布的版本**
 *     （即 `1.0.0-beta.5 < 1.0.0`），这正是「正式版发布后能毕业 beta」的关键。
 *   - 两者都带预发布时，逐段比较预发布标识：数值段按数值比，字符段按
 *     字典序比，数值段 < 字符段，段更少（且前面全等）的优先级更低。
 *
 * 此模块刻意不 import electron / electron-updater，保证可被 node:test 直接加载。
 */

/** 解析单个版本字符串为结构化对象；非法输入返回 null。 */
function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const trimmed = version.trim().replace(/^v/i, '');
  if (!trimmed) return null;

  // 拆出 build metadata（+ 之后），比较时忽略。
  const plusIndex = trimmed.indexOf('+');
  const withoutBuild = plusIndex === -1 ? trimmed : trimmed.slice(0, plusIndex);

  // 拆出预发布段（第一个 - 之后）。注意主版本段本身不含 -。
  const dashIndex = withoutBuild.indexOf('-');
  const corePart = dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex);
  const prereleasePart = dashIndex === -1 ? '' : withoutBuild.slice(dashIndex + 1);

  const coreSegments = corePart.split('.');
  if (coreSegments.length < 1 || coreSegments.length > 3) return null;

  const numeric = [];
  for (let i = 0; i < 3; i += 1) {
    const seg = coreSegments[i] ?? '0';
    if (!/^\d+$/.test(seg)) return null;
    numeric.push(Number(seg));
  }

  const prerelease = prereleasePart === '' ? [] : prereleasePart.split('.');
  for (const id of prerelease) {
    if (id.length === 0) return null;
    if (!/^[0-9A-Za-z-]+$/.test(id)) return null;
    // 数值标识符不允许前导零（semver §9）。
    if (/^\d+$/.test(id) && id.length > 1 && id.startsWith('0')) return null;
  }

  return { major: numeric[0], minor: numeric[1], patch: numeric[2], prerelease };
}

/** 比较两个预发布标识符，返回 -1 / 0 / 1。 */
function comparePrereleaseIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);

  if (aNumeric && bNumeric) {
    const diff = Number(a) - Number(b);
    return diff === 0 ? 0 : diff < 0 ? -1 : 1;
  }
  // 数值标识符优先级低于字符标识符。
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 比较两个 semver 版本。
 *
 * @param {string} a 版本字符串（可带 v 前缀 / 预发布 / build metadata）。
 * @param {string} b 版本字符串。
 * @returns {number} -1 表示 a < b；0 表示相等；1 表示 a > b。
 * @throws {Error} 任一版本无法解析时抛出。
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa) throw new Error(`Invalid version: ${String(a)}`);
  if (!pb) throw new Error(`Invalid version: ${String(b)}`);

  const coreA = [pa.major, pa.minor, pa.patch];
  const coreB = [pb.major, pb.minor, pb.patch];
  for (let i = 0; i < 3; i += 1) {
    if (coreA[i] !== coreB[i]) return coreA[i] < coreB[i] ? -1 : 1;
  }

  // 核心号相等：无预发布 > 有预发布。
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  // 两者都有预发布：逐段比较。
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const ida = pa.prerelease[i];
    const idb = pb.prerelease[i];
    // 一方段耗尽：段更少者优先级更低。
    if (ida === undefined) return -1;
    if (idb === undefined) return 1;
    const cmp = comparePrereleaseIdentifier(ida, idb);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * candidate 是否严格大于 current。
 *
 * @param {string} candidate 候选版本（如 stable 通道清单里的版本）。
 * @param {string} current 当前安装版本。
 * @returns {boolean}
 */
export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

/**
 * 版本是否为预发布（含 -beta/-alpha/-rc 等预发布标识）。
 *
 * @param {string} version
 * @returns {boolean}
 */
export function isPrerelease(version) {
  const parsed = parseVersion(version);
  return parsed ? parsed.prerelease.length > 0 : false;
}
