import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * 设备级运行时身份：持久化随机 deviceId 到 userData，sessionId 由它派生。
 *
 * 不能用 workspace basename 派生——那对所有用户是同一个全局常量，叠加后端
 * 进程级全局 projection/queue 会造成跨用户串台（A 收到 B 的本地工具命令）。
 * deviceId 跨重启稳定（projection 发布 / poll / 续聊依赖 sessionId 跨调用一致），
 * 不同机器天然不同。换机器重建是正确行为——「你是谁」由 workId 承载，不在这里。
 */
function resolveDeviceId(userDataPath) {
  const file = path.join(userDataPath, 'device-identity.json');
  try {
    if (existsSync(file)) {
      const id = JSON.parse(readFileSync(file, 'utf8'))?.deviceId;
      if (typeof id === 'string' && id.trim()) return id.trim();
    }
  } catch {
    // 文件损坏 → 落到下方重建
  }
  const deviceId = randomUUID();
  try {
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(file, JSON.stringify({ deviceId }), 'utf8');
  } catch {
    // 写失败 → 退化为本次进程内唯一，仍不串台
  }
  return deviceId;
}

function resolveLocale(input) {
  const normalized = String(input ?? '').replace('_', '-').toLowerCase();
  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }
  if (normalized.startsWith('en')) {
    return 'en-US';
  }
  return 'zh-CN';
}

export function createSessionStore({ workspaceRoot, userDataPath, listCapabilities, preferredLocale }) {
  // 懒解析 + memoize：createSessionStore 在 main.mjs 顶层执行（app ready 前），
  // 而 getSession 总在 ready 后才被调用，懒到首次取用时再读 userData，避开
  // app.getPath 的 ready 时序假设（与同仓 getDeveloperSettingsStore 等一致）。
  let cachedSessionId = null;
  function getSessionId() {
    if (!cachedSessionId) {
      cachedSessionId = `local-${resolveDeviceId(userDataPath)}`;
    }
    return cachedSessionId;
  }
  let pendingReviewCount = 0;
  let locale = resolveLocale(preferredLocale ?? process.env.LANG);

  function getSession() {
    const capabilityCount = listCapabilities().length;

    return {
      sessionId: getSessionId(),
      status: capabilityCount > 0 ? 'local_ready' : 'cloud_only',
      accessLevel: 'ask_before_local',
      capabilityCount,
      pendingReviewCount,
      locale,
      workspaceLabel: path.basename(workspaceRoot),
    };
  }

  function setPendingReviewCount(nextCount) {
    pendingReviewCount = nextCount;
  }

  function setLocale(nextLocale) {
    locale = resolveLocale(nextLocale);
  }

  return {
    getSession,
    setPendingReviewCount,
    setLocale,
  };
}
