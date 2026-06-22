/**
 * 自动更新模块（阶段一最小可用版）
 *
 * 设计原则（遵循能力代理基线）：
 *   - 更新检查/下载是“本地能力”，在主进程执行；渲染层只负责表达（后续可接 UI 提示）。
 *   - 通道（channel）由“当前应用版本号语义”决定，而非散落的环境分支：
 *       version 含 `-beta`/`-alpha`/`-rc` → 预发布通道（beta）
 *       纯 x.y.z                          → 正式通道（latest）
 *     这与 electron-builder 的 generateUpdatesFilesForAllChannels 产出的
 *     latest*.yml / beta*.yml 清单一一对应。
 *   - provider 由打包进产物的 app-update.yml（来自 electron-builder publish 配置）提供，
 *     此处不再硬编码 owner/repo，避免双事实源。
 *
 * 阶段一边界：
 *   - 仅做：检查 → 下载 → 下载完成后弹原生确认框（可选立即重启安装）。
 *   - 不做：强制安装、灰度策略、增量更新 UI、渲染层进度条（留待阶段二/三）。
 *   - 开发环境（!app.isPackaged）默认跳过，避免本地 dev 误触更新。
 */

import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

const PRERELEASE_PATTERN = /-(beta|alpha|rc)\b/i;

/**
 * 依据当前应用版本号推断更新通道。
 * @param {string} version 形如 "0.0.1" 或 "0.0.1-beta.1"
 * @returns {"beta"|"latest"}
 */
export function resolveUpdateChannel(version) {
  return PRERELEASE_PATTERN.test(String(version ?? '')) ? 'beta' : 'latest';
}

/**
 * 初始化自动更新。应在 app.whenReady 之后、窗口创建之后调用。
 *
 * @param {object} [options]
 * @param {boolean} [options.force]  忽略 isPackaged 强制启用（用于联调）。
 * @param {(info: object) => void} [options.onEvent]  可选事件回调（供未来渲染层桥接）。
 * @returns {{ channel: string, enabled: boolean }}
 */
export function initAutoUpdater(options = {}) {
  const { force = false, onEvent } = options;

  // 开发态默认不启用（避免 dev 环境误触 / 无 app-update.yml 报错）。
  const enabled = force || app.isPackaged || process.env.PEER_AGENT_FORCE_UPDATER === '1';

  const currentVersion = app.getVersion();
  const channel = resolveUpdateChannel(currentVersion);

  if (!enabled) {
    log(`updater disabled (dev mode). version=${currentVersion} channel=${channel}`);
    return { channel, enabled: false };
  }

  // 通道选择：electron-updater 通过 channel 字段决定读取哪个 *.yml。
  autoUpdater.channel = channel;
  // beta 通道需要允许预发布版本被识别为可更新目标。
  autoUpdater.allowPrerelease = channel === 'beta';
  // 阶段一：下载后让用户确认再安装，不静默强制。
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  wireEvents(onEvent);

  log(`updater init. version=${currentVersion} channel=${channel}`);

  autoUpdater.checkForUpdates().catch((err) => {
    log(`checkForUpdates failed: ${err?.message ?? err}`);
  });

  return { channel, enabled: true };
}

function wireEvents(onEvent) {
  const emit = (type, payload) => {
    log(`event=${type}${payload ? ' ' + safeJson(payload) : ''}`);
    if (typeof onEvent === 'function') {
      try {
        onEvent({ type, ...payload });
      } catch {
        /* 回调异常不应影响更新主流程 */
      }
    }
  };

  autoUpdater.on('checking-for-update', () => emit('checking-for-update'));
  autoUpdater.on('update-available', (info) => emit('update-available', { version: info?.version }));
  autoUpdater.on('update-not-available', (info) =>
    emit('update-not-available', { version: info?.version }),
  );
  autoUpdater.on('download-progress', (p) =>
    emit('download-progress', { percent: Math.round(p?.percent ?? 0) }),
  );
  autoUpdater.on('error', (err) => emit('error', { message: err?.message ?? String(err) }));
  autoUpdater.on('update-downloaded', async (info) => {
    emit('update-downloaded', { version: info?.version });
    await promptInstall(info?.version);
  });
}

async function promptInstall(version) {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons: ['立即重启更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
    title: '发现新版本',
    message: `Peer Agent ${version ?? ''} 已下载完成`,
    detail: '是否立即重启以完成更新？也可以稍后退出应用时自动安装。',
  });
  if (response === 0) {
    // isSilent=false, isForceRunAfter=true
    autoUpdater.quitAndInstall(false, true);
  }
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
