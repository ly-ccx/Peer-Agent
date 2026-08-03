import assert from 'node:assert/strict';
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
