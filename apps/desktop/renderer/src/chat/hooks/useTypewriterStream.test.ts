import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_TYPEWRITER_OPTIONS,
  THINKING_TYPEWRITER_OPTIONS,
  TYPEWRITER_FRAME_MS,
  createTypewriterPacerState,
  planTypewriterEmit,
  planTypewriterHandoff,
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

describe('typewriter ordering handoff', () => {
  it('is a no-op when nothing is buffered (must not churn the throttle)', () => {
    const decision = planTypewriterHandoff({ bufferLength: 0, nowMs: 1_000 });
    assert.equal(decision.write, false);
    assert.equal(decision.chars, 0);
  });

  it('writes the whole pending buffer so first-arrived content lands first', () => {
    const decision = planTypewriterHandoff({ bufferLength: 512, nowMs: 1_000 });
    assert.equal(decision.write, true);
    assert.equal(decision.chars, 512);
  });

  it('restarts pacing from the handoff instant instead of "first chunk" semantics', () => {
    const nowMs = 1_000;
    const decision = planTypewriterHandoff({ bufferLength: 10, nowMs });
    assert.equal(decision.lastEmitAtMs, nowMs);

    // 交接后必须重新等满一个间隔，否则交接本身就把节流打掉了。
    const pacer = { lastEmitAtMs: decision.lastEmitAtMs };
    const tooEarly = planTypewriterEmit(
      pacer,
      { bufferLength: 500, nowMs: nowMs + THINKING_TYPEWRITER_OPTIONS.minIntervalMs! - 16 },
      { ...DEFAULT_TYPEWRITER_OPTIONS, ...THINKING_TYPEWRITER_OPTIONS },
    );
    assert.equal(tooEarly.emit, false, 'handoff must not hand the throttle back to per-frame writes');
  });

  it('bounds writes when text and thinking deltas interleave at speed', () => {
    // 复刻路由器的逐 delta 交接：每来一个 delta，先交接另一侧，再推送本侧。
    // 改前用 flush()：交接会把另一侧的 buffer 整体写出并把节奏重置，
    // 于是写入次数 ≈ delta 次数（= 每个 chunk 一次整面重渲染，界面卡住）。
    const opts = { ...DEFAULT_TYPEWRITER_OPTIONS, ...THINKING_TYPEWRITER_OPTIONS };
    const deltas = 600; // 10 秒 @ 60 delta/s
    const frameMs = TYPEWRITER_FRAME_MS;

    const run = (handoffMode: 'flush' | 'handoff') => {
      let textBuffer = '';
      let thinkingBuffer = '';
      let textPacer: { lastEmitAtMs: number | null } = { lastEmitAtMs: null };
      let thinkingPacer: { lastEmitAtMs: number | null } = { lastEmitAtMs: null };
      let writes = 0;

      const drainWithFlush = (which: 'text' | 'thinking') => {
        const pending = which === 'text' ? textBuffer : thinkingBuffer;
        if (pending) writes += 1;
        if (which === 'text') {
          textBuffer = '';
          textPacer.lastEmitAtMs = null; // flush 语义：退回「首字立即写」
        } else {
          thinkingBuffer = '';
          thinkingPacer.lastEmitAtMs = null;
        }
      };

      // 真实 handoff 语义：写出积压，并把节奏时钟设为「现在」（不是首字语义）。
      const drainWithHandoff = (which: 'text' | 'thinking', nowMs: number) => {
        const pending = which === 'text' ? textBuffer : thinkingBuffer;
        if (!pending) return;
        writes += 1;
        if (which === 'text') {
          textBuffer = '';
          textPacer.lastEmitAtMs = nowMs;
        } else {
          thinkingBuffer = '';
          thinkingPacer.lastEmitAtMs = nowMs;
        }
      };

      for (let i = 0; i < deltas; i += 1) {
        const nowMs = i * frameMs;
        const isThinking = i % 2 === 0;
        if (isThinking) {
          if (handoffMode === 'flush') drainWithFlush('text');
          else drainWithHandoff('text', nowMs);
          thinkingBuffer += 'x'.repeat(2);
          // 泵自动吐字（受节流约束）
          const decision = planTypewriterEmit(
            { lastEmitAtMs: thinkingPacer.lastEmitAtMs ?? null },
            { bufferLength: thinkingBuffer.length, nowMs },
            opts,
          );
          if (decision.emit) {
            thinkingPacer.lastEmitAtMs = decision.lastEmitAtMs;
            thinkingBuffer = thinkingBuffer.slice(decision.take);
            writes += 1;
          }
        } else {
          if (handoffMode === 'flush') drainWithFlush('thinking');
          else drainWithHandoff('thinking', nowMs);
          textBuffer += 'y'.repeat(2);
          const decision = planTypewriterEmit(
            { lastEmitAtMs: textPacer.lastEmitAtMs ?? null },
            { bufferLength: textBuffer.length, nowMs },
            DEFAULT_TYPEWRITER_OPTIONS,
          );
          if (decision.emit) {
            textPacer.lastEmitAtMs = decision.lastEmitAtMs;
            textBuffer = textBuffer.slice(decision.take);
            writes += 1;
          }
        }
      }
      return writes;
    };

    const flushWrites = run('flush');
    const handoffWrites = run('handoff');
    // 逐 delta 交替（最坏情况）本身就要交接一次，所以两种模式都接近 delta 数。
    // 这条断言的目的是锁住事实：交接写是「每 delta 一次」的量级，
    // 因此 delta 级交替流不可能靠交接策略降到低频——这是尚未解决的风险点。
    assert.ok(
      flushWrites >= deltas * 0.5,
      `flush mode wrote ${flushWrites}, expected ~delta count`,
    );
    assert.ok(
      handoffWrites >= deltas * 0.5,
      `handoff mode wrote ${handoffWrites}; interleaved streams are inherently write-bound`,
    );
    // handoff 的价值在于不再额外触发「节奏被重置后的立即补写」。
    assert.ok(
      handoffWrites <= flushWrites,
      `handoff (${handoffWrites}) must not be worse than flush (${flushWrites})`,
    );
  });

  it('keeps writes bounded for a fast single-kind stream (the reported case)', () => {
    // 长思考阶段只有 thinking delta：没有交替、没有交接，写入应完全由节流决定。
    const opts = { ...DEFAULT_TYPEWRITER_OPTIONS, ...THINKING_TYPEWRITER_OPTIONS };
    const frameMs = TYPEWRITER_FRAME_MS;
    const deltas = 600; // 10 秒 @ 60 delta/s
    let buffer = '';
    let pacer: { lastEmitAtMs: number | null } = { lastEmitAtMs: null };
    let writes = 0;
    let handoffWrites = 0;

    for (let i = 0; i < deltas; i += 1) {
      const nowMs = i * frameMs;
      buffer += 'x'.repeat(2);
      // 另一侧（正文）此时 buffer 为空 → handoff 必须是纯 no-op。
      const handoff = planTypewriterHandoff({ bufferLength: 0, nowMs });
      if (handoff.write) handoffWrites += 1;

      const decision = planTypewriterEmit(
        { lastEmitAtMs: pacer.lastEmitAtMs },
        { bufferLength: buffer.length, nowMs },
        opts,
      );
      if (decision.emit) {
        pacer.lastEmitAtMs = decision.lastEmitAtMs;
        buffer = buffer.slice(decision.take);
        writes += 1;
      }
    }

    assert.equal(handoffWrites, 0, 'empty-buffer handoff must not write');
    assert.ok(writes <= 45, `expected <= 45 writes for 600 deltas, got ${writes}`);
    assert.equal(writes / (deltas / 60), writes / 10); // 约 4 次/秒
    assert.ok(writes / 10 <= 5, `writes per second was ${writes / 10}`);
  });
});

/**
 * 思考 kind 交替：目前尚未解决的结构性风险。
 *
 * 路由器在 thinking kind 变化时必须先把旧 kind 的积压写出（否则新旧内容会被并进同一段）。
 * 用 handoff 已经比 flush 好（不再停泵、不再退回「首字立即写」），但只要 buffer 非空，
 * handoff 本身就必须写一次——所以当 provider 逐 delta 交替发出 summary / reasoning 时，
 * 写入次数仍然与 delta 数同量级，节流无法生效。
 *
 * 这个矩阵把两种形态都钉住：
 *   - kind 稳定（长思考的常见形态）→ 写入由节流决定，约 4 次/秒；
 *   - kind 逐 delta 交替（最坏形态）→ 写入 ≈ delta 数，是尚未解决的风险点。
 * 如果将来把两个泵合并成「带段类型的统一队列」，交替形态应当落到第一行的量级。
 */
describe('thinking kind alternation (unresolved risk)', () => {
  const opts = { ...DEFAULT_TYPEWRITER_OPTIONS, ...THINKING_TYPEWRITER_OPTIONS };
  const deltas = 600; // 10 秒 @ 60 delta/s
  const frameMs = TYPEWRITER_FRAME_MS;

  /** 复刻路由器：每 delta 先交接正文泵；kind 变化时再交接思考泵；然后 push。 */
  function simulateThinkingStream({ alternateKind }: { alternateKind: boolean }) {
    let textBuffer = '';
    let thinkingBuffer = '';
    let textPacer: { lastEmitAtMs: number | null } = { lastEmitAtMs: null };
    let thinkingPacer: { lastEmitAtMs: number | null } = { lastEmitAtMs: null };
    let activeKind: string | undefined;
    let writes = 0;

    for (let i = 0; i < deltas; i += 1) {
      const nowMs = i * frameMs;
      const kind = alternateKind ? (i % 2 === 0 ? 'reasoning' : 'summary') : 'reasoning';

      // 交接正文泵（思考阶段正文通常为空 → 纯 no-op）
      if (textBuffer) {
        writes += 1;
        textBuffer = '';
        textPacer.lastEmitAtMs = nowMs;
      }
      if (activeKind !== kind) {
        if (thinkingBuffer) {
          writes += 1;
          thinkingBuffer = '';
          thinkingPacer.lastEmitAtMs = nowMs;
        }
        activeKind = kind;
      }

      thinkingBuffer += 'x'.repeat(2);
      const decision = planTypewriterEmit(
        { lastEmitAtMs: thinkingPacer.lastEmitAtMs },
        { bufferLength: thinkingBuffer.length, nowMs },
        opts,
      );
      if (decision.emit) {
        thinkingPacer.lastEmitAtMs = decision.lastEmitAtMs;
        thinkingBuffer = thinkingBuffer.slice(decision.take);
        writes += 1;
      }
    }
    return writes;
  }

  it('stays throttled when the thinking kind is stable (the long-thinking case)', () => {
    const writes = simulateThinkingStream({ alternateKind: false });
    assert.ok(writes <= 45, `stable-kind stream wrote ${writes} for ${deltas} deltas`);
    assert.ok(writes / (deltas / 60) <= 5, `expected <= 5 writes/s, got ${writes / (deltas / 60)}`);
  });

  it('documents that a per-delta kind flip forces one write per delta', () => {
    const writes = simulateThinkingStream({ alternateKind: true });
    assert.ok(
      writes >= deltas * 0.5,
      `alternating-kind stream wrote ${writes}; if this ever drops well below ${deltas}, ` +
        'the ordering commit has been coalesced and this comment should be updated',
    );
  });
});
