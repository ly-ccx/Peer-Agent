import { isRecoverableSystemGoalBlocker } from './goal-blocker-policy.mjs';

const RESUME_PATTERNS = [
  /^继续$/,
  /^继续执行$/,
  /^继续上一个目标$/,
  /^继续当前目标$/,
  /^恢复$/,
  /^恢复执行$/,
  /^resume$/i,
  /^continue$/i,
  /^go on$/i,
];

const PAUSE_PATTERNS = [
  /^暂停$/,
  /^先停$/,
  /^停一下$/,
  /^pause$/i,
];

const NEW_GOAL_PATTERNS = [
  /新开(一个)?目标/,
  /另起(一个)?目标/,
  /新建(一个)?目标/,
  /开始(一个)?新目标/,
  /\bnew goal\b/i,
  /\bstart (a )?new goal\b/i,
];

const CORRECTION_PATTERNS = [
  /不是这个意思/,
  /不对/,
  /走偏/,
  /理解错/,
  /错了/,
  /应该是/,
  /别这样/,
  /先别/,
  /不要再/,
  /不用继续/,
  /不再往下/,
  /剩下的/,
  /先到这/,
  /别发/,
  /停掉/,
  /不要发布/,
];

const REQUIREMENT_OVERRIDE_PATTERNS = [
  /全部改成/,
  /都改成/,
  /统一改成/,
  /改为/,
  /改成/,
  /\boverride\b/i,
];

function normalizeText(text) {
  return typeof text === 'string' ? text.trim() : '';
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifyGoalMessage(messageText) {
  const text = normalizeText(messageText);
  if (!text) {
    return {
      intent: 'empty',
      eventType: 'message_routed',
      summaryCode: 'msg_empty',
      summary: '收到一条空消息，已归入当前目标',
    };
  }

  if (matchesAny(text, NEW_GOAL_PATTERNS)) {
    return {
      intent: 'new_goal_explicit',
      eventType: 'goal_created',
      summaryCode: 'msg_new_goal_explicit',
      summary: '用户要求开一个新目标',
    };
  }

  if (matchesAny(text, PAUSE_PATTERNS)) {
    return {
      intent: 'pause',
      eventType: 'goal_paused',
      summaryCode: 'msg_paused',
      summary: `用户暂停了当前目标：${text}`,
    };
  }

  if (matchesAny(text, RESUME_PATTERNS)) {
    return {
      intent: 'resume',
      eventType: 'goal_resumed',
      summaryCode: 'msg_resumed',
      summary: `用户让当前目标继续：${text}`,
    };
  }

  if (matchesAny(text, REQUIREMENT_OVERRIDE_PATTERNS)) {
    return {
      intent: 'requirement_override',
      eventType: 'requirement_override',
      summaryCode: 'msg_requirement_override',
      summary: `用户更新了目标要求：${text}`,
    };
  }

  if (matchesAny(text, CORRECTION_PATTERNS)) {
    return {
      intent: 'correction',
      eventType: 'user_correction',
      summaryCode: 'msg_correction',
      summary: `用户纠正了执行方向：${text}`,
    };
  }

  return {
    intent: 'follow_up',
    eventType: 'message_routed',
    summaryCode: 'msg_follow_up',
    summary: `用户补充了一句，已归入当前目标：${text}`,
  };
}

const CONTINUATION_INTENTS = new Set([
  'resume',
  'follow_up',
  'correction',
  'requirement_override',
]);

export function consumesRequestedUserInput({ route, activeGoalPlan } = {}) {
  return route?.type === 'append_goal_event'
    && CONTINUATION_INTENTS.has(route.intent)
    && activeGoalPlan?.status === 'executing'
    && ['waiting_user', 'blocked'].includes(activeGoalPlan?.runner?.status)
    && activeGoalPlan?.runner?.blockedReason === 'requested_user_input';
}

/**
 * 只续接当前仍在飞的自驱 Goal。
 * 已完成（含未验收）计划是同会话下的旧 Goal：后续新开 Goal 应另建，不能把它重开或冲掉。
 */
export function resolveContinuableGoalPlan({
  activeGoalPlan,
} = {}) {
  return activeGoalPlan || null;
}

export function applyGoalMessageRoute({
  route,
  activeGoalPlan,
  goalPlanStore,
  pauseRunner,
  source = 'chat:send',
} = {}) {
  if (route?.type !== 'append_goal_event' || !route.goalPlanId) return null;

  const event = {
    type: route.eventType,
    summary: route.summary,
    payload: {
      source,
      summaryCode: route.summaryCode,
      intent: route.intent,
      messageText: route.messageText,
    },
  };

  // request_user_input is a precise governed blocker. Consume the answer and
  // clear that blocker in one store transition; unrelated blockers must remain.
  // The foreground chat turn still owns execution until its promise settles.
  if (
    consumesRequestedUserInput({ route, activeGoalPlan })
    && typeof goalPlanStore?.consumeRequestedUserInput === 'function'
  ) {
    return goalPlanStore.consumeRequestedUserInput(route.goalPlanId, event);
  }

  // A user message starts a fresh chat stream directly; it does not pass through
  // goalRunner.resume. Restore failed continuations, take over recoverable
  // infrastructure blockers, and also take over stale product blockers so the
  // home card does not keep asking for a decision while the foreground turn runs.
  // requested_user_input stays owned by consumeRequestedUserInput above.
  const continuesCurrentGoal = CONTINUATION_INTENTS.has(route.intent);
  const foregroundTakesOverSystemBlocker = continuesCurrentGoal
    && activeGoalPlan?.status === 'executing'
    && activeGoalPlan?.runner?.status === 'blocked'
    && isRecoverableSystemGoalBlocker(activeGoalPlan.runner.blockedReason);
  const foregroundTakesOverStaleBlocker = continuesCurrentGoal
    && activeGoalPlan?.status === 'executing'
    && ['blocked', 'budget_exhausted'].includes(activeGoalPlan?.runner?.status)
    && activeGoalPlan?.runner?.blockedReason !== 'requested_user_input';
  if (
    continuesCurrentGoal
    && (activeGoalPlan?.status === 'failed'
      || foregroundTakesOverSystemBlocker
      || foregroundTakesOverStaleBlocker)
  ) {
    goalPlanStore?.resumeRunner?.(route.goalPlanId, {
      intent: 'execute',
      phase: activeGoalPlan.runner?.phase === 'blocked'
        ? 'orient'
        : (activeGoalPlan.runner?.phase ?? 'orient'),
    });
  }

  // running 但还没开过回合：面板以为在跑，泵其实没转。把「继续」升级成显式 kick，
  // 让 chat:send 重新走 Runner，而不是只记日志再吐空回复。
  const turnCount = Number(activeGoalPlan?.runner?.turnCount);
  const stalledWithoutTurn = continuesCurrentGoal
    && route.intent === 'resume'
    && activeGoalPlan?.status === 'executing'
    && activeGoalPlan?.runner?.enabled === true
    && (activeGoalPlan?.runner?.status === 'running' || activeGoalPlan?.runner?.status === 'exploring')
    && (!Number.isFinite(turnCount) || turnCount <= 0);
  const appended = goalPlanStore?.appendRunEvent?.(route.goalPlanId, event) ?? null;

  // 用户改方向或撤回剩余工作：先把未完成叶子收尾，再停泵。
  // 只记事件会让计划停在 executing（例如 2/4），停止按钮一直亮着。
  // pause 只停泵，不收尾未完成任务。
  if (route.intent === 'correction') {
    if (typeof goalPlanStore?.cancelOpenTasks === 'function') {
      goalPlanStore.cancelOpenTasks(route.goalPlanId, {
        reason: route.summary || route.messageText || '用户撤回剩余工作',
      });
    }
    if (typeof pauseRunner === 'function') {
      pauseRunner(route.goalPlanId);
    }
  } else if (route.intent === 'pause' && typeof pauseRunner === 'function') {
    pauseRunner(route.goalPlanId);
  }

  if (stalledWithoutTurn) {
    return {
      type: 'kick_stalled_runner',
      goalPlanId: route.goalPlanId,
      intent: route.intent,
      eventType: route.eventType,
      summaryCode: route.summaryCode,
      summary: route.summary,
      messageText: route.messageText,
      appended,
    };
  }

  return appended;
}

export function routeGoalMessage({ messageText, activeGoalPlan } = {}) {
  const text = normalizeText(messageText);
  if (!activeGoalPlan) {
    // 隐式新目标：用户没有显式说「新建目标」，只是在 goal 模式下发了一条消息。
    // 不再无条件建 accepted 目标，而是先进 intake 判别阶段——判定是纯问答还是真实目标。
    return {
      type: 'start_intake',
      objective: text,
      intent: 'new_goal_implicit',
    };
  }

  const classification = classifyGoalMessage(text);
  if (classification.intent === 'new_goal_explicit') {
    // 显式「新建目标」是用户的明确指令，仍走 intake 收敛出具体目标后再执行，
    // 避免把一句宽泛的「新建目标做个 X」直接当成成型契约。
    return {
      type: 'start_intake',
      objective: text,
      intent: classification.intent,
    };
  }

  return {
    type: 'append_goal_event',
    goalPlanId: activeGoalPlan.planId,
    intent: classification.intent,
    eventType: classification.eventType,
    summaryCode: classification.summaryCode,
    summary: classification.summary,
    messageText: text,
  };
}
