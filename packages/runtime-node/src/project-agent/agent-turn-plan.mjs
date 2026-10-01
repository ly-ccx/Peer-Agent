import { inputMessageId } from './input-queue.mjs';
import { learnedMemoryIds, memoryListsFromResult, normalizeMemoryIds } from './reply-composer.mjs';

/** 用户回合预算。到上限后不再开始下一轮。 */
export const USER_TURN_LIMITS = Object.freeze({ maxRounds: 10, maxToolCalls: 20 });

/** 唤醒回合预算。 */
export const WAKE_TURN_LIMITS = Object.freeze({ maxRounds: 6, maxToolCalls: 12 });

/**
 * 唤醒不伪造用户消息：事件和名册进入 Context Source 的事实槽位。
 */
export function planAgentTurn({
  kind,
  userInputs = [],
  events = [],
  modelProviderId = null,
  context = null,
  roster = null,
  workspaceId = null,
} = {}) {
  const wake = kind !== 'user';
  const inputs = wake ? [] : (Array.isArray(userInputs) ? userInputs.filter(Boolean) : []);
  const facts = Array.isArray(events) ? events.filter(Boolean) : [];
  const inputAnchors = inputs.filter(input => typeof input.inputId === 'string').map(input => ({
    messageId: inputMessageId(input.inputId), ...(input.answerTo?{answerTo:input.answerTo}:{}), text: typeof input.text === 'string' ? input.text.slice(0, 400) : '',
  }));
  const { inputAnchors: _previousAnchors, ...currentContext } = context || {};
  const workspace = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  return {
    kind: wake ? 'wake' : 'user',
    mode: 'project_agent',
    turnProfile: {
      role: 'project_agent',
      ...(workspace ? { workspaceId: workspace } : {}),
      context: facts.length > 0 || roster != null || inputAnchors.length > 0
        ? { ...currentContext, ...(facts.length ? { events: facts.map((event) => ({ ...event })) } : {}), ...(roster != null ? { roster } : {}), ...(inputAnchors.length ? { inputAnchors } : {}) }
        : (context == null ? null : currentContext),
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
  memoryUsed = [],
} = {}) {
  const storedRounds = normalizeRounds(rounds);
  const messages = [agentTurnMessage({ turnId, plan, rounds: storedRounds })];
  if (failed) {
    messages.push(unavailableCard(turnId, reason, plan?.turnProfile?.workspaceId));
    return { messages, replied: false, failed: true };
  }
  const replies = postReplies(storedRounds);
  const evidenceRefs = hostEvidenceRefs(storedRounds);
  const learned = learnedMemoryIds(toolCallsOf(storedRounds));
  if (replies.length > 0) {
    replies.forEach((call, index) => {
      messages.push(attachEvidence(replyFromTool(turnId, index, call, learned, memoryUsed), evidenceRefs));
    });
    return { messages, replied: true };
  }
  if (toolCallsOf(storedRounds).some(call => call.name === 'post_reply')) {
    messages.push(unavailableCard(turnId, '回复未通过宿主校验', plan?.turnProfile?.workspaceId));
    return { messages, replied: false, failed: true };
  }
  if (plan?.kind === 'user' && finalText(storedRounds).trim()) {
    messages.push(attachEvidence(applyMemoryMeta({
      id: `${turnId}-reply`,
      role: 'assistant',
      kind: 'agent_reply',
      content: finalText(storedRounds),
      replyTo: replyTargets(plan.userInputs),
      sources: [],
      fallback: true,
      turnId,
    }, memoryUsed, learned), evidenceRefs));
    return { messages, replied: true };
  }
  if (plan?.kind === 'user') {
    messages.push(unavailableCard(turnId, '未收到有效回复', plan?.turnProfile?.workspaceId));
    return { messages, replied: false, failed: true };
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
    userInputs: Array.isArray(plan?.userInputs) ? plan.userInputs : [],
    content: '',
    rounds: normalizeRounds(rounds),
  };
}

function wakeReminder(events, roster) {
  const lines = [
    'Wake turn. These inbox events are facts, not a new user message.',
    'Speak only by calling post_reply. If nothing needs to be said, stop without post_reply.',
  ];

  return {
    id: 'project-agent-wake',
    title: 'Project agent wake',
    kind: 'project-agent-wake',
    scope: 'turn',
    layer: 'L6_MODE_REMINDER',
    content: lines.join('\n'),
  };
}

export function unavailableCard(turnId, reason, workspaceId) {
  const why = typeof reason === 'string' && reason.trim() ? reason.trim() : '未知原因';
  return {
    id: `${turnId}-card`,
    role: 'assistant',
    kind: 'system_card',
    card: 'agent_unavailable',
    content: `代理暂时不可用：${why}`,
    actions: ['retry'],
    cards: [{ cardId: `card:agent_unavailable:${turnId}`, kind: 'agent_unavailable', content: `代理暂时不可用：${why}`, actions: [{ id: 'retry', channel: 'project-agent:retry', payload: { workspaceId, turnId } }] }],
    turnId,
  };
}

function replyFromTool(turnId, index, call, learned, turnMemoryIds) {
  const validated = replyOutput(call.result);
  if (validated) return applyMemoryMeta({ ...validated, turnId }, turnMemoryIds, learned);
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
  const surfacing = surfacingOf(call.result);
  if (surfacing) {
    message.meta = {
      ...(message.meta && typeof message.meta === 'object' ? message.meta : {}),
      surfacing,
      ...(surfacing === 'silent' ? { unread: false } : {}),
    };
  }
  const fromResult = memoryListsFromResult(call.result);
  const memoryUsed = fromResult.memoryUsed.length > 0 ? fromResult.memoryUsed : turnMemoryIds;
  const memoryLearned = mergeMemoryIds(fromResult.memoryLearned, learned);
  return applyMemoryMeta(message, memoryUsed, memoryLearned);
}

function applyMemoryMeta(message, used, learned) {
  const memoryUsed = normalizeMemoryIds(used);
  const memoryLearned = normalizeMemoryIds(learned);
  if (memoryUsed.length === 0 && memoryLearned.length === 0) return message;
  const meta = message.meta && typeof message.meta === 'object' ? { ...message.meta } : {};
  if (memoryUsed.length > 0) meta.memoryUsed = memoryUsed;
  if (memoryLearned.length > 0) meta.memoryLearned = memoryLearned;
  return { ...message, meta };
}

function mergeMemoryIds(left, right) {
  return normalizeMemoryIds([...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]);
}

function surfacingOf(result) {
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return surfacingOf(JSON.parse(trimmed));
      } catch {
        return '';
      }
    }
    return '';
  }
  const piles = [];
  if (result && typeof result === 'object') piles.push(result);
  const nested = result?.output || result?.outputPreview?.legacyResult?.output;
  if (nested && typeof nested === 'object') piles.push(nested);
  if (typeof nested === 'string') {
    try {
      const parsed = JSON.parse(nested);
      if (parsed && typeof parsed === 'object') piles.push(parsed);
    } catch {
      // 工具结果不是 JSON 时没有送达标记。
    }
  }
  for (const pile of piles) {
    const value = pile?.meta?.surfacing || pile?.surfacing;
    if (value === 'interrupt' || value === 'message' || value === 'digest' || value === 'silent') return value;
  }
  return '';
}

function postReplies(rounds) {
  return toolCallsOf(rounds).filter((call) => call.name === 'post_reply' && acceptedReplyResult(call.result));
}

export function acceptedReplyResult(result) {
  if (typeof result === 'string') {
    try { return acceptedReplyResult(JSON.parse(result)); } catch { return false; }
  }
  if (!result || typeof result !== 'object') return false;
  if (result.ok === false || result.success === false || result.error || ['failed', 'denied', 'cancelled'].includes(result.status)) return false;
  const nested = result.output ?? result.outputPreview?.legacyResult ?? result.legacyResult;
  if (nested != null) return acceptedReplyResult(nested);
  return result.ok === true || result.success === true || result.status === 'success';
}

function replyOutput(result) {
  if (typeof result === 'string') {
    try { return replyOutput(JSON.parse(result)); } catch { return null; }
  }
  if (!result || typeof result !== 'object') return null;
  if (result.message?.kind === 'agent_reply') return result.message;
  return replyOutput(result.output ?? result.outputPreview?.legacyResult ?? result.legacyResult);
}

function toolCallsOf(rounds) {
  const calls = [];
  for (const round of rounds) {
    for (const call of round.toolCalls) calls.push(call);
  }
  return calls;
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
  return { ...message, meta: { ...meta, evidenceRefs: [...new Set([...(Array.isArray(meta.evidenceRefs)?meta.evidenceRefs:[]),...evidenceRefs])].slice(0,32) } };
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
