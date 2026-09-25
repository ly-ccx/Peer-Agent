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
 *     下载完成后调用 quitAndInstall() 重启安装。mac / Windows / Linux AppImage
 *     共用 electron-updater 链路；mac 由 Squirrel 校验新包与当前包的 Developer ID
 *     签名一致后原地替换，因此发布包必须持续使用同一 Team ID 签名。
 *   - 开发环境（!app.isPackaged）默认跳过，避免本地 dev 误触；可用
 *     PEER_AGENT_FORCE_UPDATER=1 强制联调。
 *   - auto 通道毕业（ADR-61）：preference='auto' 且当前版本含预发布后缀时，
 *     checkForUpdates 先静默探查 stable 通道（latest*.yml）：stable 存在严格
 *     更新的版本 → 毕业（切到 stable 通道并表达 update-available）；否则回退
 *     beta 通道做常规检查。显式 beta/stable 偏好不受毕业逻辑影响；毕业单向，
 *     升到 stable 后版本号不再含预发布后缀，auto 解析自动留在 stable。
 */

import { app, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { buildReleaseUrl } from './release-page-url.mjs';
import { createDownloadStallWatchdog } from './update-download-stall.mjs';
import {
  createUpdateCheckSchedule,
  registerActivationUpdateChecks,
} from './update-check-schedule.mjs';
import { isNewerVersion } from './update-version.mjs';
import {
  isLockedPhase,
  shouldSkipUpdateCheck,
  shouldSkipStaleUpdateEvent,
} from './updater-phase.mjs';

export { buildReleaseUrl };

const { autoUpdater } = electronUpdater;

const PRERELEASE_PATTERN = /-(beta|alpha|rc)\b/i;

/** GitHub 发布源（与 electron-builder.yml 的 publish 配置保持一致）。 */
const GITHUB_OWNER = 'ly-ccx';
const GITHUB_REPO = 'Peer-Agent';

/** 周期检测间隔：每 1 小时静默检查一次（不下载），让长期开着的应用也能发现新版本。 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

const checkSchedule = createUpdateCheckSchedule();

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
  /** 兜底用 GitHub Release 页面 URL（已知可用版本且下载/安装出错时有值） */
  releaseUrl: undefined,
  /** 事件回调（main 注入，转发到渲染窗口） */
  onEvent: undefined,
  /** 偏好读取器（main 注入，从 settingsStore 读取） */
  getPreference: undefined,
  wired: false,
  /**
   * 毕业探查中（ADR-61）：auto 偏好下静默探查 stable 通道期间置 true，
   * wireEvents 的事件处理器据此跳过状态写入与事件广播，避免探查的中间态
   * 泄漏给渲染层（探查结果由 probeStableGraduation 自行判定与表达）。
   */
  probing: false,
  /** 周期检测定时器 id（setInterval 返回值），应用退出时清理 */
  checkTimer: undefined,
  /** 应用激活/窗口聚焦监听清理器。 */
  disposeActivationChecks: undefined,
  /**
   * 下载停滞看门狗句柄（update-download-stall.mjs）。下载期间存活，
   * 正常结束/失败/停滞触发后清理。睡眠中 socket 静默死亡导致
   * read() 永久挂起时，由它把状态机置 error 并提供 Release 页面兜底。
   */
  stallWatchdog: undefined,
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

  state.disposeActivationChecks?.();
  state.disposeActivationChecks = registerActivationUpdateChecks({
    app,
    schedule: checkSchedule,
    checkForUpdates,
  });

  log(`updater init. version=${state.currentVersion} channel=${state.channel} preference=${state.preference}`);

  // 启动时静默检查一次（不下载）；失败不抛出，避免影响启动。
  void checkForUpdates();

  // 周期检测：每 1 小时静默再查一次，让长期开着的应用也能发现新版本并亮红点。
  // 复用 checkForUpdates（内部 enabled 守卫 + autoDownload=false），不新造下载路径。
  if (state.checkTimer) {
    clearInterval(state.checkTimer);
  }
  state.checkTimer = setInterval(() => {
    void checkForUpdates();
  }, CHECK_INTERVAL_MS);
  // 不阻止进程退出（Node 定时器默认 ref，这里显式 unref 更稳妥）。
  state.checkTimer.unref?.();

  return { channel: state.channel, enabled: true };
}

/**
 * 停止周期检测并清理定时器。应在应用退出（before-quit/will-quit）时调用，避免泄漏。
 */
export function stopAutoUpdater() {
  if (state.checkTimer) {
    clearInterval(state.checkTimer);
    state.checkTimer = undefined;
    log('periodic update check stopped.');
  }
  state.disposeActivationChecks?.();
  state.disposeActivationChecks = undefined;
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
    releaseUrl: state.releaseUrl,
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

/**
 * 毕业探查（ADR-61）：auto 偏好 + 预发布版本时，静默检查 stable 通道
 * （latest*.yml）是否存在严格大于当前安装版本的正式版。
 *
 * 探查期间 state.probing=true，wireEvents 的事件处理器跳过状态写入与广播，
 * 探查的中间态不泄漏给渲染层；结果由本函数返回，checkForUpdates 据此决定
 * 毕业（表达 update-available）或回退 beta 通道常规检查。
 *
 * 探查自身失败（如无网络、无 stable 清单）按「未毕业」处理，不升级错误态——
 * 毕业是增强路径，失败时应无缝回退原有 beta 检查。
 *
 * @returns {Promise<{ graduated: boolean, version?: string, releaseNotes?: string }>}
 */
async function probeStableGraduation() {
  try {
    state.probing = true;
    applyChannel('stable');
    const result = await autoUpdater.checkForUpdates();
    const candidate = result?.updateInfo?.version;
    // 毕业判定信号：stable 版本严格大于当前安装版本（semver：
    // 1.0.0 > 1.0.0-beta.5）。electron-updater 的 update-available 语义
    // 与此一致，此处显式比较保证契约清晰。
    if (candidate && isNewerVersion(candidate, state.currentVersion)) {
      return {
        graduated: true,
        version: candidate,
        releaseNotes: normalizeReleaseNotes(result?.updateInfo?.releaseNotes),
      };
    }
    return { graduated: false };
  } catch {
    return { graduated: false };
  } finally {
    state.probing = false;
  }
}

/** 主动检查更新（不下载）。 */
export async function checkForUpdates() {
  if (!state.enabled) {
    log('checkForUpdates skipped (disabled).');
    return getUpdaterStatus();
  }
  // 相位锁定：downloading/downloaded 期间（定时/激活/手动
  // recheck），直接返回当前快照。既不打断下载，也不制造迟到事件链——
  // 否则「离开一会回来」触发的激活重查会把相位打回 available，安装
  // 按钮随之消失（本次修复的主根因）。
  if (shouldSkipUpdateCheck(state.phase)) {
    log(`checkForUpdates skipped (phase locked: ${state.phase}).`);
    return getUpdaterStatus();
  }
  checkSchedule.markChecked();
  try {
    setPhase('checking');

    // ADR-61 毕业探查：仅 auto 偏好 + 当前版本含预发布后缀时触发。
    // 显式 beta/stable 偏好不走毕业（尊重用户显式选择）。
    if (state.preference === 'auto' && PRERELEASE_PATTERN.test(state.currentVersion)) {
      const probe = await probeStableGraduation();
      if (probe.graduated) {
        // 毕业：切到 stable 通道并表达 update-available。偏好保持 auto——
        // 安装 stable 后版本号不再含预发布后缀，resolveUpdateChannel 的
        // auto 回退会自然留在 stable（单向毕业，无需持久化状态）。
        state.channel = 'stable';
        applyChannel('stable');
        state.availableVersion = probe.version;
        state.releaseNotes = probe.releaseNotes;
        setPhase('available');
        emit('update-available', {
          version: probe.version,
          releaseNotes: probe.releaseNotes,
        });
        log(`graduated beta -> stable. available=${probe.version}`);
        return getUpdaterStatus();
      }
      // 未毕业：恢复 beta 通道，继续常规检查。
      applyChannel('beta');
    }

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
  // 防重入：downloading 进行中 / downloaded（安装包已就绪）时，
  // 重复点击「更新」不再发起第二次下载，直接返回当前快照。
  if (isLockedPhase(state.phase)) {
    log(`downloadUpdate skipped (phase locked: ${state.phase}).`);
    return getUpdaterStatus();
  }
  // mac（zip + latest-mac.yml）、Windows NSIS（latest.yml）与 Linux AppImage
  // （latest-linux.yml）共用 electron-updater 默认链路。.deb 安装不走应用内自动更新。
  try {
    setPhase('downloading');
    state.percent = 0;
    state.error = undefined;
    state.releaseUrl = undefined;
    startDownloadStallWatchdog();
    await autoUpdater.downloadUpdate();
  } catch (err) {
    state.error = err?.message ?? String(err);
    state.releaseUrl = currentReleaseUrl();
    setPhase('error');
    log(`downloadUpdate failed: ${state.error}`);
  } finally {
    stopStallWatchdog();
  }
  return getUpdaterStatus();
}

/** 可用版本的 Release 页面（下载/安装失败时的手动下载兜底）；无可用版本时为 undefined。 */
function currentReleaseUrl() {
  if (!state.availableVersion) return undefined;
  return buildReleaseUrl({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    version: state.availableVersion,
  });
}

/**
 * 兜底：打开当前版本的 GitHub Release 页面（下载或安装失败时由渲染层调用）。
 */
export async function openReleasePage() {
  const url = state.releaseUrl || currentReleaseUrl();
  if (!url) {
    log('openReleasePage skipped (no releaseUrl).');
    return getUpdaterStatus();
  }
  await shell.openExternal(url);
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

/**
 * 启动下载停滞看门狗（下载开始时调用）。
 * windowMs 内没有任何进度 → 置 error + 提供 Release 页面兜底。
 * 只触发一次；触发后自动停止监控。
 */
function startDownloadStallWatchdog() {
  stopStallWatchdog();
  state.stallWatchdog = createDownloadStallWatchdog({
    onStall: () => {
      log('download stalled (no progress within window); surfacing error.');
      state.error = '下载长时间无进度，可能因休眠中断。请重试，或打开 Release 页面手动下载。';
      state.releaseUrl = currentReleaseUrl();
      setPhase('error');
      emit('error', { message: state.error, releaseUrl: state.releaseUrl });
    },
  });
}

/** 停止并清理看门狗（下载正常结束/失败时调用）。 */
function stopStallWatchdog() {
  state.stallWatchdog?.stop();
  state.stallWatchdog = undefined;
}

function setPhase(phase) {
  state.phase = phase;
}

/**
 * 向渲染层广播更新事件。模块级函数，供 wireEvents 的监听器与下载停滞看门狗共用。
 */
function emit(type, payload = {}) {
  log(`event=${type}${payload && Object.keys(payload).length ? ' ' + safeJson(payload) : ''}`);
  if (typeof state.onEvent === 'function') {
    try {
      state.onEvent({ type, ...payload });
    } catch {
      /* 回调异常不应影响更新主流程 */
    }
  }
}

function wireEvents() {
  if (state.wired) return;
  state.wired = true;

  // ADR-61：毕业探查（state.probing）期间，以下六个处理器一律跳过状态写入
  // 与事件广播——探查只是静默探测 stable 清单，中间态与结果都不能经由事件
  // 通道泄漏给渲染层；探查结论由 checkForUpdates 统一表达。
  //
  // 相位锁定（updater-phase.mjs）：downloading/downloaded 期间
  // 到来的 check 类事件（checking-for-update / update-available /
  // update-not-available）属于迟到事件——来源是并发重查（激活聚焦、定时、
  // 手动）产生的旧检查流程。必须丢弃，否则会把相位打回 available，
  // 安装按钮消失。下载链路自身的事件（download-progress /
  // update-downloaded / error）不受此过滤影响。

  autoUpdater.on('checking-for-update', () => {
    if (state.probing) return;
    if (shouldSkipStaleUpdateEvent(state.phase, 'checking-for-update')) return;
    setPhase('checking');
    emit('checking-for-update');
  });

  autoUpdater.on('update-available', (info) => {
    if (state.probing) return;
    if (shouldSkipStaleUpdateEvent(state.phase, 'update-available')) return;
    state.availableVersion = info?.version;
    state.releaseNotes = normalizeReleaseNotes(info?.releaseNotes);
    setPhase('available');
    emit('update-available', {
      version: info?.version,
      releaseNotes: state.releaseNotes,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    if (state.probing) return;
    if (shouldSkipStaleUpdateEvent(state.phase, 'update-not-available')) return;
    state.availableVersion = undefined;
    setPhase('not-available');
    emit('update-not-available', { version: info?.version });
  });

  autoUpdater.on('download-progress', (p) => {
    if (state.probing) return;
    state.percent = Math.round(p?.percent ?? 0);
    state.stallWatchdog?.notifyProgress();
    setPhase('downloading');
    emit('download-progress', { percent: state.percent });
  });

  // mac Squirrel 的签名校验 / 替换失败只经由此事件上报，需一并带上手动下载兜底。
  autoUpdater.on('error', (err) => {
    if (state.probing) return;
    state.error = err?.message ?? String(err);
    state.releaseUrl = currentReleaseUrl();
    setPhase('error');
    emit('error', { message: state.error, releaseUrl: state.releaseUrl });
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (state.probing) return;
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
