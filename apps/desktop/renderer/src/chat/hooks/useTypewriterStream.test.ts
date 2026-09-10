import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_TYPEWRITER_OPTIONS,
  THINKING_TYPEWRITER_OPTIONS,
  TYPEWRITER_FRAME_MS,
  createTypewriterPacerState,
  planTypewriterEmit,
  typewriterChunkSize,
  type TypewriterOptions,
} from './useTypewriterStream.ts';

describe('typewriter stream pacing', () => {
  it('keeps per-frame pacing as the default so visible text stays smooth', () => {
    assert.deepEqual(DEFAULT_TYPEWRITER_OPTIONS, {
      minCharsPerFrame: 1,
      maxCharsPerFrame: 80,
      framesToDrain: 10,
      minIntervalMs: 0,
    });
    // minIntervalMs = 0 即「每个显示帧都可以写」，可见正文的原有行为不变。
    assert.equal(DEFAULT_TYPEWRITER_OPTIONS.minIntervalMs, 0);
  });

  it('emits small chunks for a lightly buffered stream', () => {
    assert.equal(typewriterChunkSize(1), 1);
    assert.equal(typewriterChunkSize(10), 1);
    assert.equal(typewriterChunkSize(25), 3);
    assert.equal(typewriterChunkSize(100), 10);
  });

  it('caps large backlogs so one update cannot dump an oversized block', () => {
    assert.equal(typewriterChunkSize(800), 80);
    assert.equal(typewriterChunkSize(8_000), 80);
  });

  it('honors custom drain bounds', () => {
    const options = {
      minCharsPerFrame: 2,
      maxCharsPerFrame: 20,
      framesToDrain: 5,
      minIntervalMs: 0,
    };
    assert.equal(typewriterChunkSize(1, options), 2);
    assert.equal(typewriterChunkSize(50, options), 10);
    assert.equal(typewriterChunkSize(500, options), 20);
  });
});

/**
 * 驱动「显示帧 → delta 到达 → 写入决策」的最小仿真。
 * 语义与 hook 的 tick 循环一致：每个显示帧最多决策一次，只有 decision.emit 时才真的
 * 写会话状态（= 一次聊天界面重渲染）。
 */
function simulateStream(
  options: TypewriterOptions,
  { producerCps, seconds, fps = 60 }: { producerCps: number; seconds: number; fps?: number },
) {
  const opts = { ...DEFAULT_TYPEWRITER_OPTIONS, ...options };
  const pacer = createTypewriterPacerState();
  const frameMs = 1000 / fps;
  const charsPerFrame = producerCps / fps;
  let buffer = '';
  let written = '';
  let writes = 0;
  let firstWriteAtMs: number | null = null;

  for (let frame = 0; frame < seconds * fps; frame += 1) {
    const nowMs = frame * frameMs;
    buffer += 'x'.repeat(Math.round(charsPerFrame)); // 模型 delta 到达
    const decision = planTypewriterEmit(pacer, { bufferLength: buffer.length, nowMs }, opts);
    if (decision.emit) {
      pacer.lastEmitAtMs = decision.lastEmitAtMs;
      written += buffer.slice(0, decision.take);
      buffer = buffer.slice(decision.take);
      writes += 1;
      if (firstWriteAtMs === null) firstWriteAtMs = nowMs;
    }
  }

  const produced = seconds * fps * Math.round(charsPerFrame);
  return { writes, writesPerSecond: writes / seconds, written, produced, backlog: buffer.length, firstWriteAtMs };
}

describe('typewriter write throttling', () => {
  it('documents the per-frame storm it replaces', () => {
    // 改前基线：输出快于排空速度时，泵每显示帧都写一次状态，且永远不停。
    const perFrame = simulateStream({}, { producerCps: 3000, seconds: 10 });
    assert.equal(perFrame.writes, 600);
    assert.equal(perFrame.writesPerSecond, 60);
  });

  it('caps state writes per second for the thinking profile under fast output', () => {
    const thinking = simulateStream(THINKING_TYPEWRITER_OPTIONS, { producerCps: 3000, seconds: 10 });
    assert.ok(
      thinking.writesPerSecond <= 5,
      `thinking profile wrote ${thinking.writesPerSecond}/s, expected <= 5/s`,
    );
    assert.ok(thinking.writes <= 45, `expected <= 45 writes in 10s, got ${thinking.writes}`);
    // 写入次数必须下降一个数量级以上，才可能真正消除整面重渲染造成的卡顿。
    assert.ok(thinking.writes * 10 <= 600);
  });

  it('keeps the same average throughput so throttling never lags behind the model', () => {
    const spec = { producerCps: 3000, seconds: 10 } as const;
    const perFrame = simulateStream({}, spec);
    const thinking = simulateStream(THINKING_TYPEWRITER_OPTIONS, spec);
    // 节流只是把 N 次小写入合并成 1 次大写入；吐字总量必须基本一致，不能积压。
    assert.ok(
      thinking.written.length >= perFrame.written.length * 0.98,
      `thinking emitted ${thinking.written.length} chars vs per-frame ${perFrame.written.length}`,
    );
    // 积压上限 = 一个写入间隔内模型产出的字符数：最多落后一批，且不随时间漂移。
    const oneBatchWindow = (spec.producerCps * (THINKING_TYPEWRITER_OPTIONS.minIntervalMs ?? 0)) / 1000;
    assert.ok(
      thinking.backlog <= oneBatchWindow + perFrame.backlog,
      `thinking backlog ${thinking.backlog} exceeded one batch window (${oneBatchWindow})`,
    );
    const longRun = simulateStream(THINKING_TYPEWRITER_OPTIONS, { producerCps: 3000, seconds: 60 });
    assert.ok(
      Math.abs(longRun.backlog - thinking.backlog) <= 100,
      `backlog drifted from ${thinking.backlog} (10s) to ${longRun.backlog} (60s)`,
    );
  });

  it('emits the first chunk immediately without dumping the whole buffer', () => {
    const pacer = createTypewriterPacerState();
    const options = { ...DEFAULT_TYPEWRITER_OPTIONS, ...THINKING_TYPEWRITER_OPTIONS };
    const decision = planTypewriterEmit(pacer, { bufferLength: 5000, nowMs: 0 }, options);
    assert.equal(decision.emit, true);
    assert.ok(decision.take > 0);
    assert.ok(decision.take <= options.maxCharsPerFrame);
  });

  it('holds writes inside the interval window and resumes after it', () => {
    const pacer = createTypewriterPacerState();
    const options = { ...DEFAULT_TYPEWRITER_OPTIONS, ...THINKING_TYPEWRITER_OPTIONS };

    const first = planTypewriterEmit(pacer, { bufferLength: 100, nowMs: 1000 }, options);
    assert.equal(first.emit, true);
    pacer.lastEmitAtMs = first.lastEmitAtMs;

    const tooEarly = planTypewriterEmit(
      pacer,
      { bufferLength: 100, nowMs: 1000 + options.minIntervalMs - 16 },
      options,
    );
    assert.equal(tooEarly.emit, false, 'interval window should suppress the write');
    assert.equal(tooEarly.take, 0);

    const due = planTypewriterEmit(pacer, { bufferLength: 100, nowMs: 1000 + options.minIntervalMs }, options);
    assert.equal(due.emit, true, 'write must resume once the interval elapsed');
  });

  it('never drops characters while throttled (expanding later still shows everything)', () => {
    const thinking = simulateStream(THINKING_TYPEWRITER_OPTIONS, { producerCps: 3000, seconds: 10 });
    // 被间隔挡下的帧不丢字：字符留在 buffer 里，由后续批次或流结束时的 flush() 写出。
    assert.equal(thinking.written.length + thinking.backlog, thinking.produced);
    assert.ok(thinking.firstWriteAtMs !== null && thinking.firstWriteAtMs <= TYPEWRITER_FRAME_MS * 2);
  });

  it('ships a thinking profile that only loosens the write cadence', () => {
    assert.equal(THINKING_TYPEWRITER_OPTIONS.minIntervalMs, 250);
    assert.equal(THINKING_TYPEWRITER_OPTIONS.minCharsPerFrame, undefined);
    assert.equal(THINKING_TYPEWRITER_OPTIONS.maxCharsPerFrame, undefined);
    assert.equal(THINKING_TYPEWRITER_OPTIONS.framesToDrain, undefined);
  });
});
