import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire, registerHooks } from 'node:module';

import { buildReleaseUrl } from './release-page-url.mjs';
import { isNewerVersion, isPrerelease } from './update-version.mjs';

const require = createRequire(import.meta.url);
const { AppUpdater } = require('electron-updater/out/AppUpdater.js');
let fixtureId = 0;

async function withUpdater({ current = '0.1.0-rc.3', preference = 'auto', candidates = ['0.0.18', '0.1.0-beta.5'] } = {}, run) {
  const app = new EventEmitter();
  app.isPackaged = true;
  app.getVersion = () => current;
  const updater = new AppUpdater(undefined, { version: current });
  updater.configOnDisk = { value: Promise.resolve({ provider: 'generic' }) };
  const events = [], checks = [];
  let downloads = 0, installs = 0;
  updater.checkForUpdates = async () => {
    checks.push({ channel: updater.channel, allowDowngrade: updater.allowDowngrade });
    const version = candidates.shift() ?? current;
    updater.emit('checking-for-update');
    // Deliberately inject the SDK's previous faulty available event, including older versions.
    updater.emit('update-available', { version });
    return { updateInfo: { version } };
  };
  updater.downloadUpdate = async () => {
    downloads += 1;
    updater.emit('download-progress', { percent: 42 });
    updater.emit('update-downloaded', { version: '0.1.0-rc.4' });
  };
  updater.quitAndInstall = () => { installs += 1; };
  globalThis.__peerUpdaterTest = { app, updater };
  const id = ++fixtureId;
  const electronUrl = `peer-updater-test:electron:${id}`;
  const sdkUrl = `peer-updater-test:electron-updater:${id}`;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'electron' || specifier === 'electron-updater') return { url: specifier === 'electron' ? electronUrl : sdkUrl, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === electronUrl) return { format: 'module', source: 'export const app = globalThis.__peerUpdaterTest.app; export const shell = {openExternal:async()=>{}};', shortCircuit: true };
      if (url === sdkUrl) return { format: 'module', source: 'export default {autoUpdater:globalThis.__peerUpdaterTest.updater};', shortCircuit: true };
      return next(url, context);
    },
  });
  let module;
  try {
    module = await import(`./auto-updater.mjs?behavior=${id}`);
    module.initAutoUpdater({ getPreference: () => preference, onEvent: event => events.push(event) });
    await new Promise(setImmediate);
    await run({ module, updater, events, checks, counts: () => ({ downloads, installs }) });
  } finally {
    module?.stopAutoUpdater();
    hooks.deregister();
    delete globalThis.__peerUpdaterTest;
  }
}

describe('production updater rejects downgrade before presentation, download and installation', () => {
  it('SDK channel setter never leaves downgrade enabled; RC3 rejects Beta5 and invalid candidates', async () => {
    await withUpdater({}, async ({ module, updater, events, checks, counts }) => {
      assert.equal(module.getUpdaterStatus().phase, 'not-available');
      assert.equal(events.some(event => event.type === 'update-available'), false);
      assert.deepEqual(checks.map(check => check.channel), ['latest', 'beta']);
      assert.equal(checks.every(check => check.allowDowngrade === false), true);
      for (const preference of ['stable', 'beta', 'auto']) {
        module.setChannelPreference(preference);
        assert.equal(updater.allowDowngrade, false);
      }
      for (const version of ['0.1.0-beta.5', '0.1.0-rc.3', 'invalid', '999', undefined]) {
        updater.emit('update-available', { version });
        updater.emit('update-downloaded', { version });
        assert.equal(module.getUpdaterStatus().availableVersion, undefined);
        assert.equal(updater.autoInstallOnAppQuit, false);
        await module.downloadUpdate(); module.quitAndInstall();
      }
      assert.deepEqual(counts(), { downloads: 0, installs: 0 });
    });
  });

  it('RC4 can download/install, preserving locked phases against old check events', async () => {
    await withUpdater({ preference: 'beta', candidates: ['0.1.0-rc.4'] }, async ({ module, updater, checks, counts }) => {
      assert.equal(module.getUpdaterStatus().phase, 'available');
      module.quitAndInstall();
      assert.deepEqual(counts(), { downloads: 0, installs: 0 });
      assert.equal(module.getUpdaterStatus().phase, 'available');
      await module.downloadUpdate();
      assert.equal(module.getUpdaterStatus().phase, 'downloaded');
      const before = checks.length;
      updater.emit('update-available', { version: '0.1.0-beta.5' });
      updater.emit('update-not-available', { version: '0.0.18' });
      await module.checkForUpdates(); await module.downloadUpdate();
      assert.equal(checks.length, before);
      assert.equal(module.getUpdaterStatus().availableVersion, '0.1.0-rc.4');
      assert.equal(updater.autoInstallOnAppQuit, true);
      module.quitAndInstall();
      assert.deepEqual(counts(), { downloads: 1, installs: 1 });
    });
  });

  it('auto preview graduates only to a newer stable, while explicit beta never probes stable', async () => {
    await withUpdater({ candidates: ['0.1.0'] }, async ({ module, updater, checks }) => {
      assert.equal(module.getUpdaterStatus().channel, 'stable');
      assert.equal(module.getUpdaterStatus().availableVersion, '0.1.0');
      assert.deepEqual(checks.map(check => check.channel), ['latest']);
      assert.equal(updater.allowDowngrade, false);
    });
    await withUpdater({ preference: 'beta', candidates: ['0.1.0-rc.4'] }, async ({ module, checks }) => {
      assert.equal(module.getUpdaterStatus().channel, 'beta');
      assert.deepEqual(checks.map(check => check.channel), ['beta']);
    });
  });
});

describe('auto-updater release page fallback', () => {
  describe('buildReleaseUrl', () => {
    it('builds the release tag page URL', () => {
      const url = buildReleaseUrl({
        owner: 'ly-ccx',
        repo: 'Peer-Agent',
        version: '0.0.1-beta.7',
      });
      assert.equal(
        url,
        'https://github.com/ly-ccx/Peer-Agent/releases/tag/v0.0.1-beta.7',
      );
    });
  });
});

describe('auto channel graduation decision (ADR-61)', () => {
  // 毕业探查触发条件：auto 偏好 + 当前版本含预发布后缀。
  // 毕业判定信号：stable 通道版本严格大于当前安装版本（semver）。
  // 显式 beta/stable 偏好不触发探查（由 checkForUpdates 的 preference 分支保证，
  // 此处覆盖判定信号本身的边界）。

  describe('probe trigger: current version is a prerelease', () => {
    it('triggers probing for installed beta versions', () => {
      assert.equal(isPrerelease('0.0.1-beta.7'), true);
      assert.equal(isPrerelease('1.0.0-beta.5'), true);
    });

    it('skips probing for installed stable versions', () => {
      assert.equal(isPrerelease('1.0.0'), false);
    });
  });

  describe('graduation signal: stable strictly newer than installed', () => {
    it('graduates when stable shares the beta core version', () => {
      // semver §11：1.0.0 > 1.0.0-beta.5，beta 线对应正式版已发布。
      assert.equal(isNewerVersion('1.0.0', '1.0.0-beta.5'), true);
    });

    it('graduates when stable is a later release line', () => {
      assert.equal(isNewerVersion('1.1.0', '1.0.0-beta.3'), true);
    });

    it('does not graduate when stable lags the beta baseline', () => {
      // 用户装 1.1.0-beta.3，stable 只有 1.0.0 → 继续吃 beta 通道。
      assert.equal(isNewerVersion('1.0.0', '1.1.0-beta.3'), false);
    });

    it('does not graduate when stable is older than the beta core', () => {
      assert.equal(isNewerVersion('0.9.9', '1.0.0-beta.1'), false);
    });

    it('does not graduate on identical versions', () => {
      assert.equal(isNewerVersion('1.0.0-beta.5', '1.0.0-beta.5'), false);
    });
  });
});

describe('auto-updater activation integration contract', () => {
  it('registers, shares, and disposes the activation check schedule', async () => {
    const source = await readFile(new URL('./auto-updater.mjs', import.meta.url), 'utf8');

    assert.match(source, /const checkSchedule = createUpdateCheckSchedule\(\)/);
    assert.match(source, /state\.disposeActivationChecks = registerActivationUpdateChecks\(\{[\s\S]*?app,[\s\S]*?schedule: checkSchedule,[\s\S]*?checkForUpdates,/);
    assert.match(source, /export async function checkForUpdates\(\) \{[\s\S]*?checkSchedule\.markChecked\(\)/);
    assert.match(source, /export function stopAutoUpdater\(\) \{[\s\S]*?state\.disposeActivationChecks\?\.\(\);[\s\S]*?state\.disposeActivationChecks = undefined/);
  });
});

describe('auto-updater phase-locking integration contract', () => {
  // 修复「离开一会回来后安装按钮消失」的三处源码契约：
  //   1) checkForUpdates 入口有相位锁定守卫（重查不打断 downloading/downloaded）；
  //   2) wireEvents 的 check 类事件处理器引用 shouldSkipStaleUpdateEvent（迟到事件丢弃）；
  //   3) downloadUpdate 有防重入守卫（锁定相位不发起第二次下载）。
  // 既有 auto-updater.mjs 无法在 node:test 下直接 import（依赖 electron 模块），
  // 故沿用本文件既有的「源码契约断言」约定（readFile + 正则）。

  it('checkForUpdates guards against locked phases before marking the schedule', async () => {
    const source = await readFile(new URL('./auto-updater.mjs', import.meta.url), 'utf8');

    // 入口守卫必须位于 checkSchedule.markChecked() 之前——否则锁定相位下的
    // 激活重查仍会消耗节流窗口，且后续迟到事件链依然会改写相位。
    const guardIdx = source.indexOf('if (shouldSkipUpdateCheck(state.phase))');
    const markIdx = source.indexOf('checkSchedule.markChecked()');
    assert.ok(guardIdx > -1, 'checkForUpdates must call shouldSkipUpdateCheck');
    assert.ok(markIdx > -1, 'checkForUpdates must call checkSchedule.markChecked()');
    assert.ok(guardIdx < markIdx, 'phase guard must run before markChecked()');

    // 守卫命中时返回当前快照（不是继续走网络检查）。
    assert.match(
      source,
      /if \(shouldSkipUpdateCheck\(state\.phase\)\) \{[\s\S]*?return getUpdaterStatus\(\);[\s\S]*?\n\s*\}/,
    );
  });

  it('wireEvents filters stale check events through shouldSkipStaleUpdateEvent', async () => {
    const source = await readFile(new URL('./auto-updater.mjs', import.meta.url), 'utf8');
    const wireIdx = source.indexOf('function wireEvents()');
    const wireEnd = source.indexOf('function normalizeReleaseNotes');
    assert.ok(wireIdx > -1 && wireEnd > wireIdx, 'wireEvents block not found');
    const wireBlock = source.slice(wireIdx, wireEnd);

    for (const eventType of ['checking-for-update', 'update-available', 'update-not-available']) {
      const handlerIdx = wireBlock.indexOf(`autoUpdater.on('${eventType}'`);
      assert.ok(handlerIdx > -1, `wireEvents must handle ${eventType}`);
      const skipIdx = wireBlock.indexOf(
        `if (shouldSkipStaleUpdateEvent(state.phase, '${eventType}')) return;`,
        handlerIdx,
      );
      assert.ok(
        skipIdx > handlerIdx,
        `wireEvents ${eventType} handler must call shouldSkipStaleUpdateEvent after the probing guard`,
      );
    }

    // download-progress 处理器必须喂看门狗（停滞检测依赖进度信号）。
    assert.match(
      wireBlock,
      /autoUpdater\.on\('download-progress',[\s\S]*?state\.stallWatchdog\?\.notifyProgress\(\)/,
    );
  });

  it('downloadUpdate re-entrancy guard blocks locked phases', async () => {
    const source = await readFile(new URL('./auto-updater.mjs', import.meta.url), 'utf8');

    // downloadUpdate 的防重入守卫：锁定相位直接返回快照。
    assert.match(
      source,
      /export async function downloadUpdate\(\) \{[\s\S]*?if \(isLockedPhase\(state\.phase\)\) \{[\s\S]*?return getUpdaterStatus\(\);/,
    );
  });

  it('every platform downloads through electron-updater under the stall watchdog', async () => {
    const source = await readFile(new URL('./auto-updater.mjs', import.meta.url), 'utf8');

    // mac（Squirrel + Developer ID）、Windows、Linux AppImage 共用同一条下载链路：
    // 不允许再按平台分叉出自管下载（dmg 手动安装已退役）。
    const downloadIdx = source.indexOf('export async function downloadUpdate()');
    assert.ok(downloadIdx > -1, 'downloadUpdate not found');
    const downloadBlock = source.slice(downloadIdx, source.indexOf('function currentReleaseUrl()'));
    assert.match(downloadBlock, /startDownloadStallWatchdog\(\);/);
    assert.match(downloadBlock, /autoUpdater\.downloadUpdate\(\)/);
    assert.match(downloadBlock, /\} finally \{\s*\n\s*stopStallWatchdog\(\);/);
    assert.doesNotMatch(downloadBlock, /process\.platform/);
    assert.doesNotMatch(source, /downloadUpdateMacManual|ready-to-open|installerPath|openInstaller/);

    // 下载失败时带上 Release 页面兜底。
    assert.match(downloadBlock, /state\.releaseUrl = currentReleaseUrl\(\);/);

    // 看门狗触发时置 error 并提供 Release 页面兜底（睡眠断流的恢复路径）。
    const stallFnIdx = source.indexOf('function startDownloadStallWatchdog()');
    assert.ok(stallFnIdx > -1, 'startDownloadStallWatchdog not found');
    const stallBlock = source.slice(
      stallFnIdx,
      source.indexOf('function stopStallWatchdog()'),
    );
    assert.match(stallBlock, /setPhase\('error'\);/);
    assert.match(stallBlock, /state\.releaseUrl = currentReleaseUrl\(\);/);
    assert.match(stallBlock, /emit\('error', \{ message: state\.error, releaseUrl: state\.releaseUrl \}\);/);
  });

  it('updater error events carry the release page fallback', async () => {
    const source = await readFile(new URL('./auto-updater.mjs', import.meta.url), 'utf8');

    // mac Squirrel 签名校验 / 替换失败只经由 error 事件上报，渲染层需拿到兜底链接。
    assert.match(
      source,
      /autoUpdater\.on\('error', \(err\) => \{[\s\S]*?state\.releaseUrl = currentReleaseUrl\(\);[\s\S]*?emit\('error', \{ message: state\.error, releaseUrl: state\.releaseUrl \}\);/,
    );
  });
});
