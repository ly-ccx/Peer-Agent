import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LOCKED_PHASES,
  isLockedPhase,
  shouldSkipStaleUpdateEvent,
  shouldSkipUpdateCheck,
} from './updater-phase.mjs';

/**
 * 相位锁定契约（修复「离开一会回来后安装按钮消失」的决策核心）：
 *   downloading / downloaded / ready-to-open 是不可被打断的相位——
 *   任何来源的迟到 check 类事件都必须丢弃，否则重查会把相位打回
 *   available，渲染层 isReady 失效、安装按钮消失。
 */

describe('updater phase locking', () => {
  describe('LOCKED_PHASES', () => {
    it('contains exactly downloading / downloaded / ready-to-open', () => {
      assert.deepEqual([...LOCKED_PHASES].sort(), [
        'downloaded',
        'downloading',
        'ready-to-open',
      ]);
    });

    it('isLockedPhase answers membership for every protocol phase', () => {
      for (const phase of LOCKED_PHASES) {
        assert.equal(isLockedPhase(phase), true, `phase=${phase}`);
      }
      // 非保护相位：允许事件正常处理与新一轮检查。
      for (const phase of ['idle', 'checking', 'available', 'not-available', 'error', undefined]) {
        assert.equal(isLockedPhase(phase), false, `phase=${phase}`);
      }
    });
  });

  describe('shouldSkipStaleUpdateEvent: check events are dropped while locked', () => {
    // 交叉矩阵：锁定相位 × check 类事件 → 全部跳过（迟到事件丢弃）。
    for (const phase of LOCKED_PHASES) {
      for (const eventType of [
        'checking-for-update',
        'update-available',
        'update-not-available',
      ]) {
        it(`skips ${eventType} while ${phase}`, () => {
          assert.equal(
            shouldSkipStaleUpdateEvent(phase, eventType),
            true,
            `phase=${phase} event=${eventType}`,
          );
        });
      }
    }
  });

  describe('shouldSkipStaleUpdateEvent: download-lifecycle events pass through while locked', () => {
    // 下载链路自身的事件不能被过滤：progress / downloaded / error 都要落地
    // （error 尤其重要——锁定相位下报错才能触发 Release 页面兜底）。
    for (const phase of LOCKED_PHASES) {
      for (const eventType of ['download-progress', 'update-downloaded', 'error']) {
        it(`allows ${eventType} while ${phase}`, () => {
          assert.equal(
            shouldSkipStaleUpdateEvent(phase, eventType),
            false,
            `phase=${phase} event=${eventType}`,
          );
        });
      }
    }
  });

  describe('shouldSkipStaleUpdateEvent: unlocked phases never filter', () => {
    for (const phase of ['idle', 'checking', 'available', 'not-available', 'error']) {
      for (const eventType of [
        'checking-for-update',
        'update-available',
        'update-not-available',
        'download-progress',
        'update-downloaded',
        'error',
      ]) {
        it(`allows ${eventType} while ${phase}`, () => {
          assert.equal(
            shouldSkipStaleUpdateEvent(phase, eventType),
            false,
            `phase=${phase} event=${eventType}`,
          );
        });
      }
    }
  });

  describe('shouldSkipUpdateCheck: entry guard for checkForUpdates', () => {
    for (const phase of LOCKED_PHASES) {
      it(`blocks a new check while ${phase}`, () => {
        assert.equal(shouldSkipUpdateCheck(phase), true, `phase=${phase}`);
      });
    }
    for (const phase of ['idle', 'checking', 'available', 'not-available', 'error', undefined]) {
      it(`allows a new check while ${phase}`, () => {
        assert.equal(shouldSkipUpdateCheck(phase), false, `phase=${phase}`);
      });
    }
  });
});
