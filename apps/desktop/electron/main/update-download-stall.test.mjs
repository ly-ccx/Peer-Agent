import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_STALL_WINDOW_MS,
  createDownloadStallWatchdog,
} from './update-download-stall.mjs';

/**
 * 下载停滞看门狗契约：
 *   - 窗口内无进度 → 触发一次 onStall（且只触发一次）。
 *   - 有进度 → 计时重置，窗口重新起算。
 *   - stop() 后不再触发。
 * 用真实 setTimeout 但把窗口压到毫秒级，测试总耗时 <1s。
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('download stall watchdog', () => {
  it('fires onStall once when no progress arrives within the window', async () => {
    let stalls = 0;
    const wd = createDownloadStallWatchdog({ windowMs: 20, onStall: () => { stalls += 1; } });
    await sleep(60);
    assert.equal(stalls, 1);
    wd.stop();
  });

  it('does not fire while progress keeps arriving within the window', async () => {
    let stalls = 0;
    const wd = createDownloadStallWatchdog({ windowMs: 60, onStall: () => { stalls += 1; } });
    for (let i = 0; i < 5; i += 1) {
      await sleep(20);
      wd.notifyProgress();
    }
    assert.equal(stalls, 0);
    wd.stop();
  });

  it('re-arms after each progress: fires once progress stops', async () => {
    let stalls = 0;
    const wd = createDownloadStallWatchdog({ windowMs: 40, onStall: () => { stalls += 1; } });
    await sleep(10);
    wd.notifyProgress(); // 重置：从现在起 40ms 内必须有下一次进度
    await sleep(10);
    wd.notifyProgress();
    assert.equal(stalls, 0); // 一直有进度，未触发
    await sleep(120); // 停止上报
    assert.equal(stalls, 1); // 窗口耗尽后触发，且只触发一次
    wd.stop();
  });

  it('never fires after stop()', async () => {
    let stalls = 0;
    const wd = createDownloadStallWatchdog({ windowMs: 20, onStall: () => { stalls += 1; } });
    wd.stop();
    await sleep(60);
    assert.equal(stalls, 0);
  });

  it('ignores progress after a stall already fired (single-shot)', async () => {
    let stalls = 0;
    const wd = createDownloadStallWatchdog({ windowMs: 20, onStall: () => { stalls += 1; } });
    await sleep(60);
    assert.equal(stalls, 1);
    wd.notifyProgress(); // 停滞已触发，后续进度不再重启监控
    await sleep(60);
    assert.equal(stalls, 1);
    wd.stop();
  });

  it('survives a throwing onStall callback without crashing', async () => {
    const wd = createDownloadStallWatchdog({
      windowMs: 10,
      onStall: () => {
        throw new Error('boom');
      },
    });
    await sleep(40);
    wd.stop(); // 未抛出即通过
  });

  it('exposes a 90s default window', () => {
    assert.equal(DEFAULT_STALL_WINDOW_MS, 90 * 1000);
  });
});
