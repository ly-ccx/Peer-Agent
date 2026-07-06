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
      summary: 'Empty user message routed to active Goal',
    };
  }

  if (matchesAny(text, NEW_GOAL_PATTERNS)) {
    return {
      intent: 'new_goal_explicit',
      eventType: 'goal_created',
      summary: 'User explicitly requested a new Goal',
    };
  }

  if (matchesAny(text, PAUSE_PATTERNS)) {
    return {
      intent: 'pause',
      eventType: 'goal_paused',
      summary: `User paused the current Goal: ${text}`,
    };
  }

  if (matchesAny(text, RESUME_PATTERNS)) {
    return {
      intent: 'resume',
      eventType: 'goal_resumed',
      summary: `User resumed the current Goal: ${text}`,
    };
  }

  if (matchesAny(text, REQUIREMENT_OVERRIDE_PATTERNS)) {
    return {
      intent: 'requirement_override',
      eventType: 'requirement_override',
      summary: `User updated the current Goal requirements: ${text}`,
    };
  }

  if (matchesAny(text, CORRECTION_PATTERNS)) {
    return {
      intent: 'correction',
      eventType: 'user_correction',
      summary: `User corrected the current Goal path: ${text}`,
    };
  }

  return {
    intent: 'follow_up',
    eventType: 'message_routed',
    summary: `User follow-up routed to current Goal: ${text}`,
  };
}

export function routeGoalMessage({ messageText, activeGoalPlan } = {}) {
  const text = normalizeText(messageText);
  if (!activeGoalPlan) {
    return {
      type: 'create_goal',
      objective: text,
      intent: 'new_goal_implicit',
    };
  }

  const classification = classifyGoalMessage(text);
  if (classification.intent === 'new_goal_explicit') {
    return {
      type: 'create_goal',
      objective: text,
      intent: classification.intent,
    };
  }

  return {
    type: 'append_goal_event',
    goalPlanId: activeGoalPlan.planId,
    intent: classification.intent,
    eventType: classification.eventType,
    summary: classification.summary,
    messageText: text,
  };
}
