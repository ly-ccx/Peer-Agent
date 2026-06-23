/**
 * 自动更新模块（双通道 + 渲染层驱动版）
 *
 * 设计原则（遵循能力代理基线）：
 *   - 更新检查/下载/安装是“本地能力”，全部在主进程执行；渲染层只负责表达
 *     （版本徽标红点 / 更新摘要弹窗 / 下载进度条 / 安装态）。
 *   - 通道（channel）解析遵循「设置项优先，回退版本号语义」：
 *       1. 若用户在设置中手动选择了 beta / stable → 以设置为准（权限真相）。
 *       2. 未选择（'auto'）→ 按当前应用版本号语义推断：
 *            version 含 `-beta`/`-alpha`/`-rc` → beta，否则 stable。
 *     beta → electron-updater 的 beta*.yml；stable → latest*.yml，
 *     与 electron-builder 的 generateUpdatesFilesForAllChannels 产出一一对应。
 *   - provider 由打包进产物的 app-update.yml 提供，此处不硬编码 owner/repo。
 *
 * 行为边界（按确认的产品设计）：
 *   - autoDownload=false：检查到新版本仅广播 update-available（渲染层显示红点 + 摘要），
 *     由用户在弹窗点击「更新」后才调用 downloadUpdate() 下载，进度经事件回传，
 *     下载完成后调用 quitAndInstall() 重启安装。
 *   - 开发环境（!app.isPackaged）默认跳过，避免本地 dev 误触；可用
 *     PEER_AGENT_FORCE_UPDATER=1 强制联调。
 */

import { app } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

const PRERELEASE_PATTERN = /-(beta|alpha|rc)\b/i;

/** 模块级单例状态。渲染层通过 getUpdaterStatus() 读取快照。 */
const state = {
  enabled: false,
  currentVersion: '0.0.0',
  /** 用户偏好：'auto' | 'beta' | 'stable' */
  preference: 'auto',
  /** 实际生效通道（协议）：'beta' | 'stable' */
  channel: 'stable',
  /** 流程阶段 */
  phase: 'idle',
  availableVersion: undefined,
  percent: undefined,
  error: undefined,
  releaseNotes: undefined,
  /** 事件回调（main 注入，转发到渲染窗口） */
  onEvent: undefined,
  /** 偏好读取器（main 注入，从 settingsStore 读取） */
  getPreference: undefined,
  wired: false,
};

/**
 * 依据「偏好优先，回退版本号语义」解析协议通道。
 * @param {string} version 形如 "0.0.1" 或 "0.0.1-beta.1"
 * @param {'auto'|'beta'|'stable'} [preference]
 * @returns {'beta'|'stable'}
 */
export function resolveUpdateChannel(version, preference = 'auto') {
  if (preference === 'beta' || preference === 'stable') return preference;
  return PRERELEASE_PATTERN.test(String(version ?? '')) ? 'beta' : 'stable';
}

/** 协议通道 → electron-updater 通道字段（stable 对应 latest）。 */
function toUpdaterChannel(channel) {
  return channel === 'beta' ? 'beta' : 'latest';
}

/** 把当前协议通道应用到 autoUpdater 配置。 */
function applyChannel(channel) {
  autoUpdater.channel = toUpdaterChannel(channel);
  autoUpdater.allowPrerelease = channel === 'beta';
}

/**
 * 初始化自动更新。应在 app.whenReady 之后、窗口创建之后调用。
 *
 * @param {object} [options]
 * @param {boolean} [options.force]  忽略 isPackaged 强制启用（用于联调）。
 * @param {(event: object) => void} [options.onEvent]  事件回调（转发到渲染层）。
 * @param {() => ('auto'|'beta'|'stable'|undefined)} [options.getPreference]  读取用户偏好。
 * @returns {{ channel: string, enabled: boolean }}
 */
export function initAutoUpdater(options = {}) {
  const { force = false, onEvent, getPreference } = options;

  state.onEvent = typeof onEvent === 'function' ? onEvent : undefined;
  state.getPreference = typeof getPreference === 'function' ? getPreference : undefined;
  state.currentVersion = app.getVersion();
  state.preference = normalizePreference(state.getPreference?.());
  state.channel = resolveUpdateChannel(state.currentVersion, state.preference);

  // 开发态默认不启用（避免 dev 环境误触 / 无 app-update.yml 报错）。
  const enabled = force || app.isPackaged || process.env.PEER_AGENT_FORCE_UPDATER === '1';
  state.enabled = enabled;

  if (!enabled) {
    log(`updater disabled (dev mode). version=${state.currentVersion} channel=${state.channel}`);
    return { channel: state.channel, enabled: false };
  }

  applyChannel(state.channel);
  // 关键：检查到新版本不自动下载，由渲染层弹窗用户确认后再下载。
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  wireEvents();

  log(`updater init. version=${state.currentVersion} channel=${state.channel} preference=${state.preference}`);

  // 启动时静默检查一次（不下载）；失败不抛出，避免影响启动。
  void checkForUpdates();

  return { channel: state.channel, enabled: true };
}

function normalizePreference(pref) {
  return pref === 'beta' || pref === 'stable' ? pref : 'auto';
}

/** 返回更新状态快照（UpdaterStatus 形状）。 */
export function getUpdaterStatus() {
  return {
    currentVersion: state.currentVersion || app.getVersion(),
    channel: state.channel,
    preference: state.preference,
    enabled: state.enabled,
    phase: state.phase,
    availableVersion: state.availableVersion,
    percent: state.percent,
    error: state.error,
    releaseNotes: state.releaseNotes,
  };
}

/**
 * 设置用户通道偏好（'auto'|'beta'|'stable'）。重新解析生效通道并应用。
 * 注意：偏好的持久化由调用方（main）写回 settingsStore，此处只更新运行时配置。
 * @returns {object} 最新状态快照
 */
export function setChannelPreference(preference) {
  state.preference = normalizePreference(preference);
  state.channel = resolveUpdateChannel(state.currentVersion, state.preference);
  if (state.enabled) {
    applyChannel(state.channel);
  }
  log(`channel preference set. preference=${state.preference} -> channel=${state.channel}`);
  return getUpdaterStatus();
}

/** 主动检查更新（不下载）。 */
export async function checkForUpdates() {
  if (!state.enabled) {
    log('checkForUpdates skipped (disabled).');
    return getUpdaterStatus();
  }
  try {
    setPhase('checking');
    await autoUpdater.checkForUpdates();
  } catch (err) {
    state.error = err?.message ?? String(err);
    setPhase('error');
    log(`checkForUpdates failed: ${state.error}`);
  }
  return getUpdaterStatus();
}

/** 下载已检测到的更新（用户在摘要弹窗点击「更新」后调用）。 */
export async function downloadUpdate() {
  if (!state.enabled) {
    log('downloadUpdate skipped (disabled).');
    return getUpdaterStatus();
  }
  try {
    setPhase('downloading');
    state.percent = 0;
    await autoUpdater.downloadUpdate();
  } catch (err) {
    state.error = err?.message ?? String(err);
    setPhase('error');
    log(`downloadUpdate failed: ${state.error}`);
  }
  return getUpdaterStatus();
}

/** 退出并安装已下载的更新（下载完成后调用）。 */
export function quitAndInstall() {
  if (!state.enabled) {
    log('quitAndInstall skipped (disabled).');
    return;
  }
  // isSilent=false, isForceRunAfter=true
  autoUpdater.quitAndInstall(false, true);
}

function setPhase(phase) {
  state.phase = phase;
}

function wireEvents() {
  if (state.wired) return;
  state.wired = true;

  const emit = (type, payload = {}) => {
    log(`event=${type}${payload && Object.keys(payload).length ? ' ' + safeJson(payload) : ''}`);
    if (typeof state.onEvent === 'function') {
      try {
        state.onEvent({ type, ...payload });
      } catch {
        /* 回调异常不应影响更新主流程 */
      }
    }
  };

  autoUpdater.on('checking-for-update', () => {
    setPhase('checking');
    emit('checking-for-update');
  });

  autoUpdater.on('update-available', (info) => {
    state.availableVersion = info?.version;
    state.releaseNotes = normalizeReleaseNotes(info?.releaseNotes);
    setPhase('available');
    emit('update-available', {
      version: info?.version,
      releaseNotes: state.releaseNotes,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    state.availableVersion = undefined;
    setPhase('not-available');
    emit('update-not-available', { version: info?.version });
  });

  autoUpdater.on('download-progress', (p) => {
    state.percent = Math.round(p?.percent ?? 0);
    setPhase('downloading');
    emit('download-progress', { percent: state.percent });
  });

  autoUpdater.on('error', (err) => {
    state.error = err?.message ?? String(err);
    setPhase('error');
    emit('error', { message: state.error });
  });

  autoUpdater.on('update-downloaded', (info) => {
    state.availableVersion = info?.version;
    state.percent = 100;
    setPhase('downloaded');
    emit('update-downloaded', {
      version: info?.version,
      releaseNotes: state.releaseNotes,
    });
  });
}

function normalizeReleaseNotes(notes) {
  if (!notes) return undefined;
  if (typeof notes === 'string') return notes;
  // electron-updater 在多版本聚合时可能给数组 [{ version, note }]
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (typeof n === 'string' ? n : n?.note ?? ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return undefined;
}

function log(msg) {
  // 统一前缀，便于在主进程日志中过滤。
  console.log(`[updater] ${msg}`);
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return '[unserializable]';
  }
}
