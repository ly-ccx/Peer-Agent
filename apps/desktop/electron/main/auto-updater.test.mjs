import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDmgUrl, buildReleaseUrl, mapArch } from './mac-update-url.mjs';

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
        owner: 'yinLiangDream',
        repo: 'Peer-Agent',
        version: '0.0.1-beta.7',
        arch: 'arm64',
      });
      // 文件名片段需 URL 编码（点号等保持原样，连字符约定不变）。
      assert.equal(
        url,
        'https://github.com/yinLiangDream/Peer-Agent/releases/download/v0.0.1-beta.7/Peer-Agent-0.0.1-beta.7-arm64.dmg',
      );
    });

    it('uses the provided arch segment', () => {
      const url = buildDmgUrl({
        owner: 'yinLiangDream',
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
        owner: 'yinLiangDream',
        repo: 'Peer-Agent',
        version: '0.0.1-beta.7',
      });
      assert.equal(
        url,
        'https://github.com/yinLiangDream/Peer-Agent/releases/tag/v0.0.1-beta.7',
      );
    });
  });
});
