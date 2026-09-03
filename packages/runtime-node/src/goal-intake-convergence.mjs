/**
 * Goal 模式 intake 判别收敛（方案 C）——纯决策函数。
 *
 * 背景：goal 模式首答走普通 sendMessage（不经 Runner），Runner 内的 intake 三选一
 * 收敛此路径下不会触发，导致纯问答后 intake 契约永久残留“执行中 0/1”。本模块把
 * “首答回合结束后如何收敛 intake 契约”抽成一个纯函数，便于单测覆盖三分支，
 * main.mjs 只负责按结果执行 deletePlan（副作用）。
 *
 * 口径与 goal-runner.mjs 的 intake 收敛块保持一致：
 *   - 明确目标：模型调用 goal_create_plan → upsertGoalContract 已把契约原地升级为
 *     accepted_goal（activation.kind 不再是 intake）→ 'skip'（落入正常自驱推进）。
 *   - 模糊澄清：模型调用 request_user_input（outcome.requestedUserInput=true）→ 'keep'
 *     （保留 intake 契约，等待用户下一轮回复）。
 *   - 出错/中止：回合 terminalStatus 为 error/aborted → 'keep'（不误删，交既有失败链路）。
 *   - 曾中断：契约带 runner.interruption 标记（首答被打断过，已升级为待用户确认）→ 'keep'
 *     （即使后续回合正常结束也不静默删，保留在任务页直到用户明确放弃）。
 *   - 纯问答/咨询：仍是 intake 契约、未提问、回合正常结束 → 'remove'（静默移除契约，
 *     还原普通聊天体验）。
 */

/** intake 判别契约识别：activation.kind==='intake' 表示尚未确认是否为真实目标。 */
export function isIntakeContract(plan) {
  return plan?.activation?.kind === 'intake';
}

/**
 * 决定首答回合结束后如何收敛 intake 契约。
 * @param {object|null} activePlan 当前会话的活动计划（可能为 null / 非 intake）。
 * @param {object|null} outcome sendMessage 返回的 AgentRunOutcome（含 terminalStatus / requestedUserInput）。
 * @returns {'remove'|'keep'|'skip'} remove=静默删除；keep=保留等待；skip=无需处理（无契约或已升级）。
 */
export function decideIntakeConvergence(activePlan, outcome) {
  // 无契约，或契约已被 goal_create_plan 原地升级为 accepted_goal：无需收敛。
  if (!isIntakeContract(activePlan)) return 'skip';

  const terminalStatus = outcome?.terminalStatus;
  // 出错/中止的回合不误删，保留契约交由既有失败链路处理。
  if (terminalStatus === 'error' || terminalStatus === 'aborted') return 'keep';

  // 曾中断：契约带 runner.interruption 标记（首答被打断过）→ 即使后续回合正常结束也
  // keep（升级为待用户确认，保留在任务页，直到用户明确放弃才删除）。
  if (activePlan?.runner?.interruption) return 'keep';

  // 模糊澄清：模型已调用 request_user_input，保留契约等待用户回复。
  if (outcome?.requestedUserInput) return 'keep';

  // 纯问答/咨询：既未升级、也未提问、回合正常结束 → 静默移除。
  return 'remove';
}

/**
 * 首答回合结束后是否应 auto-start Goal Runner。
 *
 * goal_create_plan 会把 intake 原地升级为 accepted_goal；intake 初始 status 为
 * executing，升级后 status 可能是 accepted 或仍保留 executing。两种都需要启动
 * Runner，否则界面会卡在「正在思考 / 0/N」。
 *
 * @param {object|null} plan 当前会话活动计划
 * @returns {boolean}
 */
export function shouldAutoStartAcceptedGoalRunner(plan) {
  if (!plan) return false;
  if (plan.workflowKind !== 'goal_self_driven') return false;
  if (plan.activation?.kind !== 'accepted_goal') return false;
  if (plan.status !== 'accepted' && plan.status !== 'executing') return false;
  const runnerStatus = plan.runner?.status;
  if (['paused', 'blocked', 'waiting_user', 'budget_exhausted', 'completed', 'failed'].includes(runnerStatus)) {
    return false;
  }
  return true;
}

/**
 * 中断挂起 / failed 计划的 re-arm 判定：goal-accepted 变更（用户/模型重新
 * goal_create_plan）可以把一个因执行中断而挂起的 accepted_goal 重新拉起。
 * - status === 'interrupted'（ADR 73）：未消费执行中断的可恢复挂起态，恢复执行由
 *   resume() 消费中断标记完成。
 * - status === 'failed'：兼容存量失败事实（含真实叶子失败），继续按既有 re-arm 路径
 *   处理。
 * runTrace 里必须有 turn 执行过才需要 re-arm；turnCount=0 说明 Runner 从未跑过一
 * 回合，属于启动窗口失败，同样允许拉起。cancelled / completed 是用户或流程的明确
 * 终态，不在此恢复。
 */
export function shouldRearmFailedGoalPlanFromChange(plan) {
  if (!plan) return false;
  if (plan.workflowKind !== 'goal_self_driven') return false;
  if (plan.activation?.kind !== 'accepted_goal') return false;
  if (plan.status !== 'failed' && plan.status !== 'interrupted') return false;
  return true;
}

/**
 * Plan store 变更广播的 auto-start 闸门。只有 intake -> accepted_goal 这一次
 * 领域跃迁能 kick Runner；Runner 自己写入的 persist / runTrace 事件绝不能反向
 * 再次触发 start，否则会形成 onChange -> start -> appendRunEvent -> onChange 自激循环。
 */
export function shouldAutoStartAcceptedGoalRunnerFromChange(change, plan) {
  if (change?.changeKind !== 'goal-accepted') return false;
  // 正常路径：accepted/executing 计划由 start() 拉起。
  if (shouldAutoStartAcceptedGoalRunner(plan)) return true;
  // re-arm 路径：中断挂起（interrupted）或失败（failed）的 accepted_goal 在收到
  // 新的 goal-accepted 变更（模型重新 goal_create_plan）时，用 resume() 消费中断
  // 标记并恢复执行，避免 turn 1 注入失败后计划永久卡死。
  return shouldRearmFailedGoalPlanFromChange(plan);
}

/**
 * A foreground answer to request_user_input may hand execution back only while
 * the same accepted Goal is still persisted as runnable. This check happens
 * after the foreground turn releases the conversation runtime.
 */
export function shouldResumeGoalRunnerAfterUserDecision(plan) {
  return shouldAutoStartAcceptedGoalRunner(plan)
    && plan?.runner?.enabled === true
    && plan?.runner?.status === 'running'
    && !plan?.runner?.blockedReason;
}

/**
 * 磁盘上标成 running，但还没有真正开过回合。
 * start() 会先写 running，再 await prepareIsolation；若这段时间被二次 kick
 * 或泵没转起来，就会留下「面板在跑、turnCount=0、没有 action_started」。
 */
export function isStalledAcceptedGoalRunner(plan) {
  if (!shouldAutoStartAcceptedGoalRunner(plan)) return false;
  if (plan?.runner?.enabled !== true) return false;
  if (plan?.runner?.status !== 'running' && plan?.runner?.status !== 'exploring') return false;
  const turnCount = Number(plan?.runner?.turnCount);
  return !Number.isFinite(turnCount) || turnCount <= 0;
}

/**
 * 串行完成 intake -> Runner 交接。forceComplete 必须返回一个 release Promise，
 * 它只在原 sendMessage 的 finally 已释放 Runtime turn 后 resolve；不能仅凭 UI 流已
 * 标记 done 就启动下一轮，否则同一 conversation session 会撞上 active turn。
 */
export async function serializeAcceptedGoalRunnerHandoff({
  forceComplete,
  isStillAccepted,
  startRunner,
}) {
  const handoff = await forceComplete();
  await handoff?.released;
  if (typeof isStillAccepted === 'function' && !isStillAccepted()) return false;
  await startRunner();
  return true;
}

/** 主进程重启后内存 session 丢失，打开会话时恢复磁盘上仍标记 running 的 Goal。 */
export function shouldRecoverAcceptedGoalRunnerOnConversationOpen(plan) {
  return shouldAutoStartAcceptedGoalRunner(plan)
    && plan?.runner?.enabled === true
    && plan?.runner?.status === 'running';
}
