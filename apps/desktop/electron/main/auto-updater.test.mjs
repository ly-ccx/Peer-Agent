import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { buildDmgUrl, buildReleaseUrl, mapArch } from './mac-update-url.mjs';
import { isNewerVersion, isPrerelease } from './update-version.mjs';

describe('auto-updater mac manual download helpers', () => {
  describe('mapArch', () => {
    it('maps x64 to x64', () => {
      assert.equal(mapArch('x64'), 'x64');
    });

    it('maps arm64 to arm64', () => {
      assert.equal(mapArch('arm64'), 'arm64');
    });

    it('falls back to arm64 for unknown arch', () => {
      assert.equal(mapArch('mips'), 'arm64');
      assert.equal(mapArch(undefined), 'arm64');
    });
  });

  describe('buildDmgUrl', () => {
    it('builds the dmg URL following the artifactName convention', () => {
      const url = buildDmgUrl({
        owner: 'ly-ccx',
        repo: 'Peer-Agent',
        version: '0.0.1-beta.7',
        arch: 'arm64',
      });
      // 文件名片段需 URL 编码（点号等保持原样，连字符约定不变）。
      assert.equal(
        url,
        'https://github.com/ly-ccx/Peer-Agent/releases/download/v0.0.1-beta.7/Peer-Agent-0.0.1-beta.7-arm64.dmg',
      );
    });

    it('uses the provided arch segment', () => {
      const url = buildDmgUrl({
        owner: 'ly-ccx',
        repo: 'Peer-Agent',
        version: '1.2.3',
        arch: 'x64',
      });
      assert.ok(url.endsWith('/v1.2.3/Peer-Agent-1.2.3-x64.dmg'));
    });
  });

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
  //   1) checkForUpdates 入口有相位锁定守卫（重查不打断 downloading/ready-to-open）；
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

  it('mac manual download runs under the stall watchdog and cleans it up', async () => {
    const source = await readFile(new URL('./auto-updater.mjs', import.meta.url), 'utf8');

    // 下载开始即启动看门狗；进度回调喂狗；finally 里清理。
    const macIdx = source.indexOf('async function downloadUpdateMacManual()');
    assert.ok(macIdx > -1, 'downloadUpdateMacManual not found');
    const macBlock = source.slice(macIdx, source.indexOf('function downloadToFile'));
    assert.match(macBlock, /startDownloadStallWatchdog\(\);/);
    assert.match(macBlock, /state\.stallWatchdog\?\.notifyProgress\(\);/);
    assert.match(macBlock, /\} finally \{\s*\n\s*stopStallWatchdog\(\);/);

    // Windows 路径同样受看门狗保护。
    const winIdx = source.indexOf('export async function downloadUpdate()');
    const winBlock = source.slice(winIdx, macIdx);
    assert.match(winBlock, /startDownloadStallWatchdog\(\);/);
    assert.match(winBlock, /\} finally \{\s*\n\s*stopStallWatchdog\(\);/);

    // 看门狗触发时置 error 并提供 Release 页面兜底（睡眠断流的恢复路径）。
    const stallFnIdx = source.indexOf('function startDownloadStallWatchdog()');
    assert.ok(stallFnIdx > -1, 'startDownloadStallWatchdog not found');
    const stallBlock = source.slice(
      stallFnIdx,
      source.indexOf('function stopStallWatchdog()'),
    );
    assert.match(stallBlock, /setPhase\('error'\);/);
    assert.match(stallBlock, /emit\('error', \{ message: state\.error \}\);/);
    assert.match(stallBlock, /buildReleaseUrl\(/);
  });
});
