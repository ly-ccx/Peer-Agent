/**
 * TUI Goal Runner 接入层 —— 与 Desktop 主进程同一套自驱编排。
 *
 * 背景（为什么 CLI goal 模式此前「永远不生效」）：
 * - Desktop 在 main.mjs 里 createGoalRunner，并在 goal-plan-store onChange
 *   (changeKind === 'goal-accepted') 时立刻 kick Runner，驱动 runGoalTurn 循环；
 * - TUI 此前只有 goal-bridge（goal 工具 + 共享 store + intake 门禁）和
 *   goal-status 展示，没有任何东西在计划 accepted 后启动 Runner，
 *   于是计划停在 `0/0 · accepted` 永远不动。
 *
 * 本模块做三件事，与 Desktop 对齐：
 * 1. 直接复用 @peer-agent/runtime-node 的 createGoalRunner
 *    （Desktop/TUI 同一份编排逻辑），chatRuntime.runGoalTurn 由 TUI chat 会话驱动；
 * 2. 复用共享 Goal intake 的 auto-start 闸门纯函数，
 *    只有 intake → accepted_goal 这一次领域跃迁会 kick Runner，Runner 自己写盘
 *    触发的 change 不会反向自激；
 * 3. 向 TUI 暴露 runner 状态订阅（供状态面板展示）与控制入口（/goal pause 等）。
 *
 * Worker 对齐：
 * - Explorer / Verifier 由 ChatController 暴露的窄接口执行；
 * - Controller 内部为每个 Worker 创建独立 explorer-mode Runtime Pipeline，
 *   因此共享 Runner 不接触模型、工具投影或主聊天历史。
 */

import {
  createGoalRunner,
  shouldAutoStartAcceptedGoalRunnerFromChange,
} from '@peer-agent/runtime-node';

import type { ChatController } from './chat-controller.ts';
import type { TuiGoalBridge } from './goal-bridge.ts';

export interface TuiGoalRunnerEvent {
  readonly type: string;
  readonly planId?: string;
  readonly [key: string]: unknown;
}

export interface TuiSharedGoalRunner {
  start(planId: string): Promise<unknown>;
  pause(planId: string, reason?: string): unknown;
  resume(planId: string): Promise<unknown>;
  clear(planId: string): unknown;
  waitForIdle(planId: string): Promise<unknown>;
  getState(planId: string): unknown;
  /** Milestone D: Desktop/TUI 共享崩溃恢复入口。 */
  recoverContextCheckpoints?(options?: { maxAgeMs?: number }): {
    scanned: number;
    recovered: unknown[];
    skipped: unknown[];
  };
  /** 订阅 runner 领域事件（started/tickCompleted/blocked/completed/failed/paused 等）。 */
  subscribe(listener: (event: TuiGoalRunnerEvent) => void): () => void;
}

export interface TuiGoalTurnRuntime {
  /** 等待当前 intake turn（若仍在跑）结束，再 kick Runner，避免与活跃 turn 冲突。 */
  whenIdle(): Promise<void>;
  /** Runner 每个 tick 通过它驱动 CLI chat，并返回该回合登记的 Worker 请求。 */
  runGoalTurn(content: string): ReturnType<ChatController['runGoalTurn']>;
}

function buildGoalRunnerMessage(plan: any, turnNumber: number): string {
  const planLabel = plan?.title || plan?.goal || plan?.planId || 'goal';
  return `Goal Runner tick ${turnNumber} for goal "${planLabel}" (planId=${plan?.planId || 'unknown'}). Continue from the active GoalPlan state. Open tasks are not finished by narrating the next read/search/edit; emit a real tool call in this same turn.`;
}

function createIdleWaiter(chat: Pick<ChatController, 'getSnapshot' | 'subscribe'>) {
  return async function whenIdle(): Promise<void> {
    if (chat.getSnapshot().status === 'idle') return;
    await new Promise<void>((resolve) => {
      const unsubscribe = chat.subscribe((snapshot) => {
        if (snapshot.status === 'idle') {
          unsubscribe();
          resolve();
        }
      });
    });
  };
}

export function createTuiSharedGoalRunner(options: {
  readonly bridge: TuiGoalBridge;
  readonly chat: Pick<
    ChatController,
    'getSnapshot' | 'subscribe' | 'runGoalTurn' | 'runExplorer' | 'runVerifier'
  >;
  /** 当前 TUI runtime 正在承载的 conversation。GoalPlan 只能由其所属 conversation 推进。 */
  readonly getConversationId: () => string | undefined;
  /** 是否订阅 store onChange 并自动 kick（仅真实运行时开启；测试可注入禁用）。 */
  readonly autoStart?: boolean;
  readonly logger?: Pick<Console, 'warn' | 'error'>;
}): TuiSharedGoalRunner {
  const { bridge, chat, getConversationId } = options;
  const logger = options.logger ?? console;
  const store = bridge.store;
  const listeners = new Set<(event: TuiGoalRunnerEvent) => void>();

  const emit = (event: TuiGoalRunnerEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn?.('[tui-goal-runner] listener failed:', error as never);
      }
    }
  };

  const whenIdle = createIdleWaiter(chat);
  const ownsPlan = (plan: { conversationId?: unknown } | null | undefined): boolean => {
    const ownerConversationId = typeof plan?.conversationId === 'string'
      ? plan.conversationId.trim()
      : '';
    const runtimeConversationId = getConversationId()?.trim() ?? '';
    return ownerConversationId.length > 0
      && runtimeConversationId.length > 0
      && ownerConversationId === runtimeConversationId;
  };

  const runtime: TuiGoalTurnRuntime = {
    whenIdle,
    runGoalTurn: (content) => chat.runGoalTurn(content),
  };

  const runner = createGoalRunner({
    goalPlanStore: store,
    canRunPlan: ownsPlan,
    chatRuntime: {
      async runGoalTurn({ plan, turnNumber }: { plan: any; turnNumber: number }) {
        try {
          // 与 Desktop runGoalTurn 同语义：把 tick 消息作为下一轮 user 输入交给会话。
          return await runtime.runGoalTurn(buildGoalRunnerMessage(plan, turnNumber));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { failed: true, failureReason: message };
        }
      },
    },
    explorerRunner: {
      runExplorer: (input: Parameters<ChatController['runExplorer']>[0]) => chat.runExplorer(input),
    },
    verifierRunner: {
      runVerifier: (input: Parameters<ChatController['runVerifier']>[0]) => chat.runVerifier(input),
    },
    emitEvent: (event: TuiGoalRunnerEvent) => emit(event),
    logger,
  });

  // Milestone D: recover interrupted Goal compaction/resume on TUI start,
  // matching Desktop app.whenReady recoverContextCheckpoints.
  try {
    if (typeof (runner as any).recoverContextCheckpoints === 'function') {
      const recovery = (runner as any).recoverContextCheckpoints();
      if (recovery?.recovered?.length) {
        emit({
          type: 'goalRunner:recovered',
          recovered: recovery.recovered.length,
          scanned: recovery.scanned,
        } as TuiGoalRunnerEvent);
      }
    }
  } catch (error) {
    // recovery failure must not block TUI startup
    logger.warn?.(
      '[tui-goal-runner] recoverContextCheckpoints failed:',
      error instanceof Error ? error.message : (error as never),
    );
  }


  // —— 对齐 Desktop main.mjs 的 maybeAutoStartAcceptedGoalFromPlanChange ——
  // 只有 intake → accepted_goal 的领域跃迁（changeKind === 'goal-accepted'）会 kick。
  function maybeAutoStartFromChange(payload: any) {
    const planId = typeof payload?.planId === 'string' ? payload.planId : null;
    if (!planId) return;
    const plan = typeof store?.getPlan === 'function' ? store.getPlan(planId) : null;
    if (!shouldAutoStartAcceptedGoalRunnerFromChange(payload, plan) || !ownsPlan(plan)) return;
    void (async () => {
      try {
        // 等 intake turn 结束再 kick，避免与当前活跃 turn 冲突
        // （Desktop 用 forceComplete + released；TUI 用快照 status === 'idle' 等价）。
        await runtime.whenIdle();
        const latest = typeof store?.getPlan === 'function' ? store.getPlan(planId) : null;
        // 等待期间 TUI 可能已经切换 conversation，必须重新确认 plan 仍归当前 runtime。
        if (!shouldAutoStartAcceptedGoalRunnerFromChange(payload, latest) || !ownsPlan(latest)) return;
        await runner.start(planId);
      } catch (error) {
        logger.error?.(
          '[tui-goal-runner] auto-start failed:',
          error instanceof Error ? error.message : (error as never),
        );
      }
    })();
  }

  // 经 bridge.subscribeChanges 挂 auto-start，而不是独占 store.setOnChange。
  // goal-bridge 会 fan-out 进程内 onChange，同时保留 .changes.jsonl 跨进程兜底；
  // 这样 TUI Goal 面板也能在 create 当下立刻刷新。
  if (options.autoStart !== false && typeof bridge.subscribeChanges === 'function') {
    bridge.subscribeChanges((payload: any) => {
      maybeAutoStartFromChange(payload);
    });
  }

  return {
    start: (planId) => runner.start(planId),
    pause: (planId, reason) => runner.pause(planId, reason),
    resume: async (planId) => {
      await runtime.whenIdle();
      return runner.resume(planId);
    },
    clear: (planId) => runner.clear(planId),
    waitForIdle: (planId) => runner.waitForIdle(planId),
    getState: (planId) => runner.getState(planId),
    // Milestone D: Desktop/TUI share the same crash-recovery entry.
    recoverContextCheckpoints: (options) => {
      if (typeof (runner as any).recoverContextCheckpoints === 'function') {
        return (runner as any).recoverContextCheckpoints(options);
      }
      return { scanned: 0, recovered: [], skipped: [] };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
