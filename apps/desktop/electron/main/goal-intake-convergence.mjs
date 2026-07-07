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

  // 模糊澄清：模型已调用 request_user_input，保留契约等待用户回复。
  if (outcome?.requestedUserInput) return 'keep';

  // 纯问答/咨询：既未升级、也未提问、回合正常结束 → 静默移除。
  return 'remove';
}
