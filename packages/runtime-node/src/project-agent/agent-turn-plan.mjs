import { inputMessageId } from './input-queue.mjs';

/** 用户回合预算。到上限后不再开始下一轮。 */
export const USER_TURN_LIMITS = Object.freeze({ maxRounds: 10, maxToolCalls: 20 });

/** 唤醒回合预算。 */
export const WAKE_TURN_LIMITS = Object.freeze({ maxRounds: 6, maxToolCalls: 12 });

/**
 * 组装一轮项目代理回合。唤醒不伪造用户消息：事件和名册只进 reminder。
 * `turnProfile.context` 留给 B2-11，这里只原样放进槽位。
 */
export function planAgentTurn({
  kind,
  userInputs = [],
  events = [],
  modelProviderId = null,
  context = null,
  roster = null,
} = {}) {
  const wake = kind !== 'user';
  const inputs = wake ? [] : (Array.isArray(userInputs) ? userInputs.filter(Boolean) : []);
  const facts = Array.isArray(events) ? events.filter(Boolean) : [];
  return {
    kind: wake ? 'wake' : 'user',
    mode: 'project_agent',
    turnProfile: {
      role: 'project_agent',
      context: context ?? null,
    },
    modelProviderId: modelProviderId ?? null,
    limits: { ...(wake ? WAKE_TURN_LIMITS : USER_TURN_LIMITS) },
    userInputs: inputs.map((input) => ({ ...input })),
    events: facts.map((event) => ({ ...event })),
    roster: roster ?? null,
    reminder: wake ? wakeReminder(facts, roster) : null,
  };
}

/**
 * 回合结束后要写入对话的消息。可见回复只有 post_reply；
 * 用户回合没有任何 post_reply 时，用最终文本兜底挂到本回合全部输入上。
 */
export function finishAgentTurn({
  turnId,
  plan,
  rounds = [],
  failed = false,
  reason = '',
} = {}) {
  const storedRounds = normalizeRounds(rounds);
  const messages = [agentTurnMessage({ turnId, plan, rounds: storedRounds })];
  if (failed) {
    messages.push(unavailableCard(turnId, reason));
    return { messages, replied: false };
  }
  const replies = postReplies(storedRounds);
  const evidenceRefs = hostEvidenceRefs(storedRounds);
  if (replies.length > 0) {
    replies.forEach((call, index) => {
      messages.push(attachEvidence(replyFromTool(turnId, index, call), evidenceRefs));
    });
    return { messages, replied: true };
  }
  if (plan?.kind === 'user') {
    messages.push(attachEvidence({
      id: `${turnId}-reply`,
      role: 'assistant',
      kind: 'agent_reply',
      content: finalText(storedRounds),
      replyTo: replyTargets(plan.userInputs),
      sources: [],
      fallback: true,
      turnId,
    }, evidenceRefs));
    return { messages, replied: true };
  }
  return { messages, replied: false };
}

export function agentTurnMessage({ turnId, plan, rounds = [] } = {}) {
  return {
    id: turnId,
    role: 'assistant',
    kind: 'agent_turn',
    turnId,
    turnKind: plan?.kind === 'wake' ? 'wake' : 'user',
    content: '',
    rounds: normalizeRounds(rounds),
  };
}

function wakeReminder(events, roster) {
  const lines = [
    'Wake turn. These inbox events are facts, not a new user message.',
    'Speak only by calling post_reply. If nothing needs to be said, stop without post_reply.',
    `Events: ${JSON.stringify(events)}`,
  ];
  if (roster != null) lines.push(`Roster: ${JSON.stringify(roster)}`);
  return {
    id: 'project-agent-wake',
    title: 'Project agent wake',
    kind: 'project-agent-wake',
    scope: 'turn',
    layer: 'L6_MODE_REMINDER',
    content: lines.join('\n'),
  };
}

function unavailableCard(turnId, reason) {
  const why = typeof reason === 'string' && reason.trim() ? reason.trim() : '未知原因';
  return {
    id: `${turnId}-card`,
    role: 'assistant',
    kind: 'system_card',
    card: 'agent_unavailable',
    content: `代理暂时不可用：${why}`,
    actions: ['retry'],
    turnId,
  };
}

function replyFromTool(turnId, index, call) {
  const input = call.input && typeof call.input === 'object' ? call.input : {};
  const message = {
    id: `${turnId}-reply-${index + 1}`,
    role: 'assistant',
    kind: 'agent_reply',
    content: typeof input.text === 'string' ? input.text : '',
    replyTo: stringList(input.replyTo),
    sources: stringList(input.sources),
    fallback: false,
    turnId,
  };
  if (input.proactive === true) message.proactive = true;
  if (input.question && typeof input.question === 'object') message.question = input.question;
  return message;
}

function postReplies(rounds) {
  const replies = [];
  for (const round of rounds) {
    for (const call of round.toolCalls) {
      if (call.name === 'post_reply') replies.push(call);
    }
  }
  return replies;
}

function replyTargets(inputs) {
  const ids = [];
  for (const input of inputs || []) {
    const id = messageIdFor(input);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function messageIdFor(input) {
  if (typeof input?.messageId === 'string' && input.messageId.trim()) return input.messageId.trim();
  if (typeof input?.id === 'string' && input.id.startsWith('input-')) return input.id;
  try {
    return inputMessageId(input?.inputId);
  } catch {
    return '';
  }
}

function finalText(rounds) {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const text = rounds[index]?.text;
    if (typeof text === 'string' && text.trim()) return text;
  }
  return '';
}

function normalizeRounds(rounds) {
  return (Array.isArray(rounds) ? rounds : []).map((round) => ({
    text: typeof round?.text === 'string' ? round.text : '',
    toolCalls: (Array.isArray(round?.toolCalls) ? round.toolCalls : []).map((call) => ({
      name: typeof call?.name === 'string' ? call.name : '',
      input: call?.input ?? null,
      result: call?.result ?? null,
    })),
  }));
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
}

const EVIDENCE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const EVIDENCE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/;

function hostEvidenceRefs(rounds) {
  const refs = [];
  for (const round of rounds) {
    for (const call of round.toolCalls) {
      if (call.name === 'post_reply') continue;
      collectEvidenceRefs(call.result, refs, 0);
    }
  }
  return refs.slice(0, 20);
}

function attachEvidence(message, evidenceRefs) {
  if (evidenceRefs.length === 0) return message;
  const meta = message.meta && typeof message.meta === 'object' ? message.meta : {};
  return { ...message, meta: { ...meta, evidenceRefs } };
}

function collectEvidenceRefs(value, refs, depth) {
  if (refs.length >= 20 || depth > 6) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        collectEvidenceRefs(JSON.parse(trimmed), refs, depth + 1);
      } catch {
        // 不是 JSON 的正文不拿来当证据引用。
      }
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.ok === false || value.status === 'failed') return;
  addEvidenceRef(refs, value.evidenceRef);
  if (Array.isArray(value.evidenceRefs)) {
    for (const item of value.evidenceRefs) addEvidenceRef(refs, item);
  }
  for (const key of ['output', 'detail', 'result', 'legacyResult', 'outputPreview']) {
    if (value[key] != null) collectEvidenceRefs(value[key], refs, depth + 1);
  }
  for (const list of [value.checks, value.outputs]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) collectEvidenceRefs(item, refs, depth + 1);
  }
}

function addEvidenceRef(refs, value) {
  if (refs.length >= 20 || typeof value !== 'string') return;
  const text = value.trim();
  if (!text || text.length > 500 || text.includes('..') || /[\s\u0000-\u001f\\]/.test(text)) return;
  if (!EVIDENCE_URI.test(text) && !EVIDENCE_TOKEN.test(text)) return;
  if (!refs.includes(text)) refs.push(text);
}
