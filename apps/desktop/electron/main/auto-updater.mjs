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
 *   - auto 通道毕业（ADR-61）：preference='auto' 且当前版本含预发布后缀时，
 *     checkForUpdates 先静默探查 stable 通道（latest*.yml）：stable 存在严格
 *     更新的版本 → 毕业（切到 stable 通道并表达 update-available）；否则回退
 *     beta 通道做常规检查。显式 beta/stable 偏好不受毕业逻辑影响；毕业单向，
 *     升到 stable 后版本号不再含预发布后缀，auto 解析自动留在 stable。
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { buildDmgUrl, buildReleaseUrl, mapArch } from './mac-update-url.mjs';
import {
  createUpdateCheckSchedule,
  registerActivationUpdateChecks,
} from './update-check-schedule.mjs';
import { isNewerVersion } from './update-version.mjs';

export { buildDmgUrl, buildReleaseUrl, mapArch };

const { autoUpdater } = electronUpdater;

const PRERELEASE_PATTERN = /-(beta|alpha|rc)\b/i;

/** GitHub 发布源（与 electron-builder.yml 的 publish 配置保持一致）。 */
const GITHUB_OWNER = 'ly-ccx';
const GITHUB_REPO = 'Peer-Agent';

/** mac 自管下载的 dmg 存放子目录（位于系统临时目录下）。 */
const MAC_UPDATE_DIR = 'peer-agent-updates';

/** 周期检测间隔：每 1 小时静默检查一次（不下载），让长期开着的应用也能发现新版本。 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 打开 dmg 成功后到主动退出本程序之间的延迟（毫秒）。
 * 给 Finder 一点时间弹出 dmg 挂载窗口，再退出自身——这样用户能直接把新版本
 * 拖入「应用程序」覆盖安装（旧版仍在运行时 macOS 无法覆盖）。
 */
const QUIT_AFTER_OPEN_DELAY_MS = 1000;

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
  /** mac 自管下载完成的 dmg 本地路径（phase='ready-to-open' 时有值） */
  installerPath: undefined,
  /** 兜底用 GitHub Release 页面 URL（mac 下载失败时有值） */
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
    installerPath: state.installerPath,
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
  // mac 走自管下载链路：应用为 ad-hoc 签名，Squirrel 的「下载→签名校验→原子替换」
  // 会在校验步骤失败（code requirement 不满足）。改为自管下载 dmg + 手动打开。
  if (process.platform === 'darwin') {
    return downloadUpdateMacManual();
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

/**
 * mac 自管下载：拼 dmg URL → HEAD 校验 → 流式下载到 temp → 完成置 ready-to-open。
 * 任一步失败则置 error 并带上 Release 页面 URL，由渲染层提供「打开 Release 页面」兜底。
 */
async function downloadUpdateMacManual() {
  const version = state.availableVersion;
  const releaseUrl = buildReleaseUrl({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    version,
  });
  if (!version) {
    state.error = 'No available version to download.';
    state.releaseUrl = releaseUrl;
    setPhase('error');
    return getUpdaterStatus();
  }

  const arch = mapArch(process.arch);
  const dmgUrl = buildDmgUrl({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    version,
    arch,
  });

  try {
    setPhase('downloading');
    state.percent = 0;
    state.error = undefined;
    state.releaseUrl = undefined;
    state.installerPath = undefined;
    emit('download-progress', { percent: 0 });

    // 1) HEAD 校验：资产缺失/命名漂移时尽早暴露并兜底。
    const head = await fetchWithProxyFallback(dmgUrl, { method: 'HEAD', redirect: 'follow' });
    if (!head.ok) {
      throw new Error(`dmg not found (HTTP ${head.status})`);
    }

    // 2) 准备落盘目录（清空旧 dmg，避免堆积）。
    const dir = path.join(tmpdir(), MAC_UPDATE_DIR);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const dest = path.join(dir, `Peer-Agent-${version}-${arch}.dmg`);

    // 3) 流式下载并按 Content-Length 上报进度。
    await downloadToFile(dmgUrl, dest, (percent) => {
      state.percent = percent;
      emit('download-progress', { percent });
    });

    // 4) 完成 → ready-to-open，由用户点击「打开安装包」。
    //    注意：不广播 update-downloaded 事件——渲染层该事件处理器会把 phase 置为
    //    'downloaded'（Windows 语义），与 mac 的 'ready-to-open' 冲突。mac 的终态
    //    由 downloadUpdate() 的 await 返回快照承载（含 installerPath）。
    //    进度事件均在 await 解析前触发，故不会反向覆盖终态。
    state.installerPath = dest;
    state.percent = 100;
    setPhase('ready-to-open');
  } catch (err) {
    state.error = err?.message ?? String(err);
    state.releaseUrl = releaseUrl;
    setPhase('error');
    log(`downloadUpdateMacManual failed: ${state.error}`);
  }
  return getUpdaterStatus();
}

/**
 * 解析 Electron 的 net.fetch（基于 Chromium 网络栈，自动遵循系统/环境代理）。
 * 取不到时返回 null，由调用方回退到 Node 全局 fetch。
 */
async function getElectronNetFetch() {
  try {
    const electron = await import('electron');
    const net = electron?.net || electron?.default?.net;
    return typeof net?.fetch === 'function' ? net.fetch.bind(net) : null;
  } catch {
    return null;
  }
}

/**
 * 带代理回退的 fetch：优先用 Electron net.fetch（走系统/环境代理，国内代理下更快），
 * 失败再回退到 Node 全局 fetch 重试一次（undici 不读代理，作为直连兜底）。
 * net.fetch 不可用时直接用 Node fetch。
 */
async function fetchWithProxyFallback(url, init = {}) {
  const netFetch = await getElectronNetFetch();
  if (!netFetch) return fetch(url, init);
  try {
    return await netFetch(url, init);
  } catch (err) {
    log(`net.fetch failed, falling back to node fetch: ${err?.message ?? err}`);
    return fetch(url, init);
  }
}

/**
 * 流式下载 url 到 dest，按 Content-Length 回报 0–100 整数进度。
 * 无 Content-Length 时进度停留在已知上一值，完成时由调用方置 100。
 */
async function downloadToFile(url, dest, onProgress) {
  const res = await fetchWithProxyFallback(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`download failed (HTTP ${res.status})`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const fileStream = createWriteStream(dest);
  // 用 getReader() 而非 for-await：Electron net.fetch 返回的 Web ReadableStream
  // 在当前版本不支持异步迭代，全库流式读取（provider adapters）均用此范式，
  // 对 net.fetch 与 Node fetch 两种 body 都兼容。
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      fileStream.write(value);
      if (total > 0 && typeof onProgress === 'function') {
        onProgress(Math.min(99, Math.floor((received / total) * 100)));
      }
    }
  } finally {
    fileStream.end();
  }
  await new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });
}

/**
 * 打开已下载的 mac 安装包（dmg）。渲染层在 phase='ready-to-open' 时调用。
 * 打开失败回退到打开 Release 页面。
 */
export async function openInstaller() {
  const target = state.installerPath;
  if (!target) {
    log('openInstaller skipped (no installerPath).');
    return getUpdaterStatus();
  }
  const result = await shell.openPath(target);
  if (result) {
    // openPath 返回非空字符串表示错误信息。回退打开 Release 页面，且不退出本程序
    // （没有可覆盖的本地包，退出只会打断用户）。
    log(`openInstaller failed: ${result}`);
    if (state.releaseUrl) {
      await shell.openExternal(state.releaseUrl);
    }
    return getUpdaterStatus();
  }
  // 成功打开 dmg：稍候让 Finder 弹出挂载窗口，再主动退出本程序，
  // 使用户可直接把新版本拖入「应用程序」覆盖安装。退出复用既有
  // before-quit → stopAutoUpdater() 清理链路。
  log('openInstaller succeeded; quitting app to allow overwrite install.');
  setTimeout(() => {
    app.quit();
  }, QUIT_AFTER_OPEN_DELAY_MS);
  return getUpdaterStatus();
}

/**
 * 兜底：打开当前版本的 GitHub Release 页面（mac 下载失败时由渲染层调用）。
 */
export async function openReleasePage() {
  const url =
    state.releaseUrl ||
    (state.availableVersion
      ? buildReleaseUrl({
          owner: GITHUB_OWNER,
          repo: GITHUB_REPO,
          version: state.availableVersion,
        })
      : undefined);
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

function setPhase(phase) {
  state.phase = phase;
}

/**
 * 向渲染层广播更新事件。模块级函数，供 wireEvents 的监听器与 mac 自管下载链路共用。
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

  autoUpdater.on('checking-for-update', () => {
    if (state.probing) return;
    setPhase('checking');
    emit('checking-for-update');
  });

  autoUpdater.on('update-available', (info) => {
    if (state.probing) return;
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
    state.availableVersion = undefined;
    setPhase('not-available');
    emit('update-not-available', { version: info?.version });
  });

  autoUpdater.on('download-progress', (p) => {
    if (state.probing) return;
    state.percent = Math.round(p?.percent ?? 0);
    setPhase('downloading');
    emit('download-progress', { percent: state.percent });
  });

  autoUpdater.on('error', (err) => {
    if (state.probing) return;
    state.error = err?.message ?? String(err);
    setPhase('error');
    emit('error', { message: state.error });
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
