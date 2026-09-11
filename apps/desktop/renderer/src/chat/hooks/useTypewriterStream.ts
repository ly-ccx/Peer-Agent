import { useCallback, useEffect, useRef } from 'react';
import { getStreamProfiler } from '../state/streamProfiler.ts';

/**
 * 平滑流式打字机泵。
 *
 * 解决"生硬吐字"问题：网络/模型按自己的节奏（大块、不均匀）推送 delta，
 * 但显示层用独立的、自适应速率的 requestAnimationFrame 循环按字符匀速吐出，
 * 让用户始终看到丝滑连续的文字流，而不是一坨一坨地跳。
 *
 * 设计要点：
 * - 接收与显示解耦：push() 只往 buffer 追加，绝不直接触发渲染。
 * - 自适应速率：buffer 积压越多，每帧吐字越快，保证显示不会落后网络太久。
 * - 帧级批处理：一帧最多调用一次 onText，告别"每个 chunk 一次 setState"。
 * - flush()：流结束时立刻把剩余 buffer 全部吐出，避免末尾延迟。
 */

export interface TypewriterOptions {
  /** 每次吐字最少的字符数（buffer 不空时的下限） */
  readonly minCharsPerFrame?: number;
  /** 每次吐字最多的字符数（防止超大 buffer 一口全吐导致不平滑） */
  readonly maxCharsPerFrame?: number;
  /**
   * 期望在多少个吐字周期内把当前积压消化完。越小越快、越激进。
   * 实际速率 = ceil(buffer.length / framesToDrain)，再 clamp 到 [min, max]。
   */
  readonly framesToDrain?: number;
  /**
   * 两次「真正写出文本」之间的最小间隔（毫秒）。0 = 每个显示帧都可以写（默认）。
   *
   * 每一次写出都会落到会话状态并触发一次聊天界面重渲染，所以这个值决定的是
   * 重渲染频率，而不是文字本身的平滑度。可见正文需要跟随屏幕刷新率，保持 0；
   * 折叠状态下不可见的思考过程没有这个需求，放宽它即可把写入从 60 次/秒降到低频批量。
   */
  readonly minIntervalMs?: number;
}

export const DEFAULT_TYPEWRITER_OPTIONS: Required<TypewriterOptions> = {
  minCharsPerFrame: 1,
  maxCharsPerFrame: 80,
  framesToDrain: 10,
  minIntervalMs: 0,
};

/**
 * 思考过程流的写入节奏（不可见内容的低频批量档）。
 *
 * 思考段默认是收起的（只显示「正在思考」+ 时长），正文根本不进 DOM，所以没有任何
 * 跟随屏幕刷新率逐帧写状态的理由：逐帧写入只会让聊天界面每秒被整面重渲染 60 次，
 * 而且只要模型输出快于排空速度，这个泵就永远不停——这正是「思考时整个界面卡住、
 * 输出越快越明显」的来源。
 *
 * 250ms 一批 ≈ 4 次/秒（原为 60 次/秒），远快于人眼阅读；单批字符数按经过时间放大
 * （上限仍受 maxCharsPerFrame 约束），所以平均吐字吞吐与逐帧模式一致，不会落后于
 * 模型输出，也不会因为节流丢字。流结束时 flush() 会把剩余 buffer 一次写完。
 */
export const THINKING_TYPEWRITER_OPTIONS: TypewriterOptions = { minIntervalMs: 250 };

export function typewriterChunkSize(
  bufferLength: number,
  options: Required<TypewriterOptions> = DEFAULT_TYPEWRITER_OPTIONS,
): number {
  if (bufferLength <= 0) return 0;
  const target = Math.ceil(bufferLength / options.framesToDrain);
  return Math.max(options.minCharsPerFrame, Math.min(options.maxCharsPerFrame, target));
}

/** 参考显示帧时长：把「按帧限速」的吐字节奏换算成「按时间片批量」。 */
export const TYPEWRITER_FRAME_MS = 1000 / 60;

/**
 * 计算一次写出实际吐出的字符数。
 *
 * minIntervalMs = 0 时等价于 typewriterChunkSize（每显示帧一次）。
 * 一旦限制写入间隔，就按「距上次写出本该经过的帧数」放大单次批量，让平均吐字
 * 速率与逐帧模式一致：只是把 N 次小写入合并成 1 次大写入，不会让显示落后于积压。
 */
export function typewriterBurstSize(
  bufferLength: number,
  elapsedMs: number,
  options: Required<TypewriterOptions> = DEFAULT_TYPEWRITER_OPTIONS,
): number {
  const perFrame = typewriterChunkSize(bufferLength, options);
  if (perFrame <= 0 || options.minIntervalMs <= 0) return perFrame;
  const frames = Math.max(1, Math.floor(elapsedMs / TYPEWRITER_FRAME_MS));
  return Math.min(bufferLength, perFrame * frames);
}

/** 写入节奏状态：lastEmitAtMs = null 表示泵刚启动、还没有写过任何文本。 */
export interface TypewriterPacerState {
  lastEmitAtMs: number | null;
}

export function createTypewriterPacerState(): TypewriterPacerState {
  return { lastEmitAtMs: null };
}

export interface TypewriterEmitDecision {
  /** 本次是否真的要写出文本（false = 被写入间隔挡下，本帧不写状态） */
  readonly emit: boolean;
  /** 要写出的字符数 */
  readonly take: number;
  /** 写出后应记录的时间戳 */
  readonly lastEmitAtMs: number;
}

export interface TypewriterHandoffDecision {
  /** 是否需要立刻写出（buffer 为空时为 false，= 纯 no-op） */
  readonly write: boolean;
  /** 一次写出的字符数 */
  readonly chars: number;
  /** 写出后应记录的时间戳；节奏从此刻重新计算 */
  readonly lastEmitAtMs: number;
}

/**
 * 顺序交接决策：把当前 buffer 立即写出，保证「先到的内容先落到状态」。
 *
 * 正文与思考是两段不同的内容，谁先写出谁就排在前面，所以交接必须真的写。
 * 但交接不该顺带把写入节流打掉：
 *  - buffer 为空 = 纯 no-op（不停泵、不改节奏时钟），否则高频 delta 每来一个就重置一次；
 *  - 有内容时写完后按「现在」重算节奏，而不是退回「首字立即写」语义，
 *    否则交接后紧接着又会触发一次写出。
 */
export function planTypewriterHandoff(
  input: { readonly bufferLength: number; readonly nowMs: number },
): TypewriterHandoffDecision {
  if (input.bufferLength <= 0) {
    return { write: false, chars: 0, lastEmitAtMs: input.nowMs };
  }
  return { write: true, chars: input.bufferLength, lastEmitAtMs: input.nowMs };
}

/**
 * 打字机写入决策：本帧该不该写、写多少。
 *
 * 纯函数，便于在没有渲染器的测试里直接驱动高频 delta 并断言写入次数上限。
 */
export function planTypewriterEmit(
  state: TypewriterPacerState,
  input: { readonly bufferLength: number; readonly nowMs: number },
  options: Required<TypewriterOptions> = DEFAULT_TYPEWRITER_OPTIONS,
): TypewriterEmitDecision {
  if (input.bufferLength <= 0) {
    return { emit: false, take: 0, lastEmitAtMs: state.lastEmitAtMs ?? 0 };
  }
  const lastEmitAtMs = state.lastEmitAtMs;
  const hasEmittedBefore = lastEmitAtMs !== null;
  if (options.minIntervalMs > 0 && hasEmittedBefore) {
    if (input.nowMs - lastEmitAtMs < options.minIntervalMs) {
      return { emit: false, take: 0, lastEmitAtMs };
    }
  }
  // 泵启动后的第一笔按「一帧」的量吐：既立刻出字，又不会把起步变成一次性大喷发。
  const elapsedMs = hasEmittedBefore ? input.nowMs - lastEmitAtMs : TYPEWRITER_FRAME_MS;
  const take = typewriterBurstSize(input.bufferLength, elapsedMs, options);
  return { emit: take > 0, take, lastEmitAtMs: input.nowMs };
}

export interface TypewriterController {
  /** 追加新收到的文本片段（来自网络 delta） */
  push: (text: string) => void;
  /** 立即吐出全部剩余 buffer 并停止泵（流正常结束时调用） */
  flush: () => void;
  /**
   * 顺序交接：把当前 buffer 立即写出，但不停泵、不重置写入节奏。
   * 用于「正文/思考互相切换」这类需要保序的场合——它们必须写出，但不该
   * 顺带把写入节流打掉（那会让每个 delta 都触发一次整面重渲染）。
   */
  handoff: () => void;
  /** 丢弃 buffer 并停止泵（中断/出错/切换会话时调用） */
  reset: () => void;
}

export function useTypewriterStream(
  onText: (chunk: string) => void,
  options: TypewriterOptions = {},
): TypewriterController {
  const opts = { ...DEFAULT_TYPEWRITER_OPTIONS, ...options };
  const bufferRef = useRef('');
  const rafRef = useRef<number | null>(null);
  const pacerRef = useRef<TypewriterPacerState>(createTypewriterPacerState());
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stopLoop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    const buffer = bufferRef.current;
    if (buffer.length === 0) {
      // buffer 空了：暂停泵，等下一次 push 再启动，避免空转。
      rafRef.current = null;
      return;
    }
    // requestAnimationFrame 仍是调度时钟：每个显示帧最多决策一次。
    // 但「要不要真的写会话状态」由 pacer 的写入间隔决定——折叠状态下不可见的思考
    // 过程不需要每帧 materialize，放宽间隔即把写入从 60 次/秒降到低频批量，并按
    // 经过时间放大单次批量，保证平均吐字速率不变、不落后积压。
    const decision = planTypewriterEmit(
      pacerRef.current,
      { bufferLength: buffer.length, nowMs: performance.now() },
      opts,
    );
    if (decision.emit) {
      pacerRef.current.lastEmitAtMs = decision.lastEmitAtMs;
      const chunk = buffer.slice(0, decision.take);
      bufferRef.current = buffer.slice(decision.take);
      onTextRef.current(chunk);
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [opts.framesToDrain, opts.minCharsPerFrame, opts.maxCharsPerFrame, opts.minIntervalMs]);

  const ensureRunning = useCallback(() => {
    if (rafRef.current == null) {
      // 泵从静止重新启动：允许下一笔立刻写出，不因写入间隔把首字推迟。
      pacerRef.current.lastEmitAtMs = null;
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [tick]);

  const push = useCallback((text: string) => {
    if (!text) return;
    bufferRef.current += text;
    // 观测：push 次数 = 前台 delta 到达速率（两个泵各自计数后汇总）。
    const profiler = getStreamProfiler();
    profiler.bump('typewriter.push');
    profiler.setGauge('typewriter.bufferChars', bufferRef.current.length);
    ensureRunning();
  }, [ensureRunning]);

  /**
   * 顺序交接：把当前 buffer 立即写出，保证「先到的内容先落到状态」。
   *
   * 用于正文/思考互相切换时的排序（两者是不同段，谁先写出谁排前面）。
   * 与 flush() 的区别：buffer 为空时是纯 no-op，且不停止泵、不把节奏时钟退回
   * 「首字立即写」——否则每个 delta 的交接都会把写入节流打掉，界面重新变成
   * 每个 chunk 一次整面重渲染。flush() 仍然用于「结束/切会话」这类真正的收口。
   */
  const handoff = useCallback(() => {
    const decision = planTypewriterHandoff({
      bufferLength: bufferRef.current.length,
      nowMs: performance.now(),
    });
    if (!decision.write) return;
    const remaining = bufferRef.current;
    bufferRef.current = '';
    pacerRef.current.lastEmitAtMs = decision.lastEmitAtMs;
    const profiler = getStreamProfiler();
    profiler.bump('typewriter.handoff');
    profiler.bump('typewriter.handoffChars', remaining.length);
    onTextRef.current(remaining);
  }, []);

  const flush = useCallback(() => {
    stopLoop();
    pacerRef.current.lastEmitAtMs = null;
    const remaining = bufferRef.current;
    bufferRef.current = '';
    if (remaining) {
      // 观测：flush 会把积压一次性写出并重置吐字节奏，等于绕过写入节流；
      // 若它被每个 delta 触发，节流就形同虚设（排查卡顿的关键指标）。
      const profiler = getStreamProfiler();
      profiler.bump('typewriter.flush');
      profiler.bump('typewriter.flushChars', remaining.length);
      onTextRef.current(remaining);
    }
  }, [stopLoop]);

  const reset = useCallback(() => {
    stopLoop();
    pacerRef.current.lastEmitAtMs = null;
    bufferRef.current = '';
  }, [stopLoop]);

  // 组件卸载时清理 rAF，防止泄漏。
  useEffect(() => stopLoop, [stopLoop]);

  return { push, flush, handoff, reset };
}
