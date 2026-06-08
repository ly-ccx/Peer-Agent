/**
 * OTA 自动更新模块
 *
 * 基于 electron-updater generic provider，从阿里云 OSS 拉取更新。
 * - Beta 通道: 版本号包含 "-beta" 时，channel = "beta"
 * - Stable 通道: 正式版本号，channel = "latest"
 *
 * 行为:
 * 1. 启动后 30s 静默检查更新（不打扰首屏体验）
 * 2. 之后每 4 小时检查一次
 * 3. 发现新版本 → 通知 renderer（不自动下载）
 * 4. renderer 决定何时下载/安装
 */

import { app, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;

// 根据当前版本是否含 beta 判断更新通道
function resolveChannel() {
  const version = app.getVersion();
  return version.includes('beta') ? 'beta' : 'latest';
}

let mainWindowRef = null;

export function initAutoUpdater(mainWindow) {
  // 仅打包态才启用自动更新
  if (!app.isPackaged) {
    console.log('[auto-updater] skipped: running in dev mode');
    return;
  }

  mainWindowRef = mainWindow;

  const channel = resolveChannel();
  autoUpdater.channel = channel;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  // 设置更新 URL (覆盖 electron-builder.yml 中的默认)
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: `https://zeus-atlas.oss-cn-beijing.aliyuncs.com/releases/${channel}`,
  });

  console.log(`[auto-updater] initialized, channel=${channel}`);

  // ── Events → renderer ──
  autoUpdater.on('checking-for-update', () => {
    console.log('[auto-updater] checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[auto-updater] update available:', info.version);
    mainWindowRef?.webContents.send('update:available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[auto-updater] no update available');
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindowRef?.webContents.send('update:progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[auto-updater] update downloaded:', info.version);
    mainWindowRef?.webContents.send('update:downloaded', {
      version: info.version,
    });
  });

  autoUpdater.on('error', (err) => {
    const msg = err?.message || '';
    // 404 = 尚未发布过任何版本，属于正常情况，静默忽略
    if (msg.includes('404') || msg.includes('NET_ERR') || msg.includes('ENOTFOUND')) {
      console.log('[auto-updater] no release published yet, skipping.');
      return;
    }
    console.error('[auto-updater] error:', msg || err);
    mainWindowRef?.webContents.send('update:error', {
      message: msg || 'Unknown update error',
    });
  });

  // ── 定时检查 ──
  // 启动后 30s 首次检查
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => {
      console.error('[auto-updater] check failed:', e?.message);
    });
  }, 30_000);

  // 之后每 4 小时检查一次
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((e) => {
      console.error('[auto-updater] periodic check failed:', e?.message);
    });
  }, 4 * 60 * 60_000);
}

/**
 * 注册 renderer → main 的更新 IPC
 */
export function registerUpdaterIPC() {
  // 手动检查更新
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { available: false, reason: 'dev-mode' };
    try {
      const result = await autoUpdater.checkForUpdates();
      return { available: !!result?.updateInfo, version: result?.updateInfo?.version };
    } catch (e) {
      return { available: false, error: e?.message };
    }
  });

  // 开始下载
  ipcMain.handle('update:download', async () => {
    await autoUpdater.downloadUpdate();
    return { success: true };
  });

  // 退出并安装
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // 获取当前版本
  ipcMain.handle('update:current-version', () => ({
    version: app.getVersion(),
    channel: resolveChannel(),
  }));
}
