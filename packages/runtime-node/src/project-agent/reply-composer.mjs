/**
 * 把 post_reply 整理成锚定回复。
 * replyTo、sources、结论标记、记忆 id 和送达方式只来自宿主事实。
 * 模型附在工具参数上的结论、标记和卡片不会进入结果。
 */
import { planDelivery } from './digest.mjs';

const TEXT_MAX = 2000;
const ID_MAX = 200;
const LIST_MAX = 20;
const ORIGINS = new Set(['user_request', 'objective_signal', 'agent_idea']);
const EVENT_KINDS = new Set([
  'needs_user',
  'confirm',
  'failure_needs_decision',
  'result',
  'observation',
  'idea',
  'objective_risk',
]);
const SEVERITIES = new Set(['info', 'notable', 'urgent']);
const PROACTIVITY = new Set(['off', 'low', 'normal', 'high', 'quiet', 'standard', 'muted']);
const OUTCOMES = new Set(['passed', 'failed', 'partial', 'unverifiable']);

/**
 * @param {object} [input]
 * @returns {{ ok: true, message: object, meta: object, marks: object[] } | { ok: false, error: string, message: string }}
 */
export function composeReply(input = {}) {
  const messageId = boundedId(input.messageId, ID_MAX);
  if (!messageId) return fail('invalid_input', 'messageId is required.');
  if (input.kind !== 'user' && input.kind !== 'wake') {
    return fail('invalid_input', 'kind must be user or wake.');
  }
  if (typeof input.text !== 'string') return fail('invalid_input', 'text is required and must be at most 2000 characters.');
  const text = input.text.trim();
  if (!text || text.length > TEXT_MAX) {
    return fail('invalid_input', 'text is required and must be at most 2000 characters.');
  }

  const turnId = readOptionalId(input.turnId, 'turnId');
  if (turnId && turnId.ok === false) return turnId;
  const replyTo = readList(input.replyTo, 'replyTo must be a list of message ids.');
  if (replyTo && replyTo.ok === false) return replyTo;
  const sources = readList(input.sources, 'sources must be a list of session ids.');
  if (sources && sources.ok === false) return sources;
  const turnInputIds = readList(input.turnInputIds, 'turnInputIds must be a list of message ids.');
  if (turnInputIds && turnInputIds.ok === false) return turnInputIds;
  const question = readQuestion(input.question);
  if (question && question.ok === false) return question;
  const sessionIds = readIdSet(input.projectSessionIds, 'projectSessionIds must be a list of session ids.');
  if (sessionIds && sessionIds.ok === false) return sessionIds;
  const memoryUsed = readList(input.memoryUsed, 'memoryUsed must be a list of memory ids.');
  if (memoryUsed && memoryUsed.ok === false) return memoryUsed;
  const memoryLearned = readList(input.memoryLearned, 'memoryLearned must be a list of memory ids.');
  if (memoryLearned && memoryLearned.ok === false) return memoryLearned;
  const evidenceRefs = readEvidenceRefs(input.evidenceRefs);
  if (evidenceRefs && evidenceRefs.ok === false) return evidenceRefs;
  if (input.toolCalls != null && !Array.isArray(input.toolCalls)) {
    return fail('invalid_input', 'toolCalls must be a list.');
  }
  if (input.userMessages != null && !Array.isArray(input.userMessages)) {
    return fail('invalid_input', 'userMessages must be a list.');
  }
  if (input.verdicts != null && !Array.isArray(input.verdicts)) {
    return fail('invalid_input', 'verdicts must be a list.');
  }
  const surfacing = readSurfacing(input.surfacing);
  if (!surfacing.ok) return surfacing;

  const fallback = input.fallback === true;
  const proactive = input.proactive === true;
  if (fallback && input.kind !== 'user') {
    return fail('fallback_not_allowed', 'Only a user turn can fall back to an anchored reply.');
  }

  const anchors = fallback ? turnInputIds.ids : replyTo.ids;
  if (anchors.length === 0 && !proactive) {
    return fail('reply_to_required', 'replyTo is required unless proactive is true.');
  }
  const indexed = indexUserMessages(input.userMessages);
  const membership = checkAnchors(anchors, indexed);
  if (!membership.ok) return membership;
  const forged = sources.ids.filter((id) => !sessionIds.ids.has(id));
  if (forged.length > 0) {
    return fail('forged_sources', 'sources must be session ids of this project.', { sessionIds: forged });
  }

  const verdicts = indexVerdicts(input.verdicts);
  const marks = marksFor(sources.ids, verdicts);
  const verdictRef = latestVerdictRef(sources.ids, verdicts);
  const learned = mergeIds(memoryLearned.ids, learnedFromTools(input.toolCalls));
  const meta = {
    replyTo: anchors,
    sources: sources.ids,
    ...(verdictRef ? { verdictRef } : {}),
    memoryUsed: memoryUsed.ids,
    memoryLearned: learned,
    ...(evidenceRefs.ids.length > 0 ? { evidenceRefs: evidenceRefs.ids } : {}),
    surfacing: surfacing.decision,
  };
  const message = {
    id: messageId,
    role: 'assistant',
    kind: 'agent_reply',
    content: text,
    replyTo: meta.replyTo,
    sources: meta.sources,
    fallback,
    ...(turnId.id ? { turnId: turnId.id } : {}),
    ...(proactive ? { proactive: true } : {}),
    ...(question.value ? { question: question.value } : {}),
    meta,
    marks,
  };
  return { ok: true, message, meta, marks };
}

function fail(error, message, extra = {}) {
  return { ok: false, error, message, ...extra };
}

function boundedId(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\r\n]/.test(trimmed)) return '';
  return trimmed;
}

function readOptionalId(value, label) {
  if (value == null) return { id: '' };
  const id = boundedId(value, ID_MAX);
  if (!id) return fail('invalid_input', `${label} is invalid.`);
  return { id };
}

function readList(value, message) {
  if (value == null) return { ids: [] };
  const ids = stringList(value, { min: 0, max: LIST_MAX, itemMax: ID_MAX });
  if (!ids) return fail('invalid_input', message);
  return { ids };
}

function readEvidenceRefs(value) {
  if (value == null) return { ids: [] };
  const ids = stringList(value, { min: 0, max: LIST_MAX, itemMax: 500 });
  if (!ids) return fail('invalid_input', 'evidenceRefs must be a list of evidence refs.');
  const allowed = ids.filter((id) => !id.includes('..') && !/[\s\\]/.test(id));
  return { ids: allowed };
}

function readIdSet(value, message) {
  const list = readList(value, message);
  if (list.ok === false) return list;
  return { ids: new Set(list.ids) };
}

function readQuestion(question) {
  if (question == null) return { value: null };
  if (typeof question !== 'object' || Array.isArray(question)) {
    return fail('invalid_input', 'question.options must contain 1 to 8 choices.');
  }
  const options = stringList(question.options, { min: 1, max: 8, itemMax: ID_MAX });
  if (!options) return fail('invalid_input', 'question.options must contain 1 to 8 choices.');
  return { value: { options } };
}

function stringList(value, { min, max, itemMax }) {
  if (!Array.isArray(value) || value.length > max) return null;
  const ids = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > itemMax) return null;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  if (ids.length < min) return null;
  return ids;
}

function indexUserMessages(messages) {
  const byId = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const id = boundedId(message.id || message.messageId, ID_MAX);
    if (!id || byId.has(id)) continue;
    byId.set(id, message);
  }
  return byId;
}

function isUserInput(message) {
  const kind = message?.kind || message?.type || message?.messageKind;
  if (kind === 'user_input') return true;
  if (typeof kind === 'string' && kind) return false;
  return message?.role === 'user';
}

function checkAnchors(ids, byId) {
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return fail('anchor_not_found', 'replyTo message was not found in this conversation.', {
      messageIds: missing,
    });
  }
  const rejected = ids.filter((id) => !isUserInput(byId.get(id)));
  if (rejected.length > 0) {
    return fail('anchor_not_user_input', 'replyTo must be a user_input message.', {
      messageIds: rejected,
    });
  }
  return { ok: true };
}

function readSurfacing(value) {
  const input = value == null ? {} : value;
  if (typeof input !== 'object' || Array.isArray(input)) {
    return fail('invalid_input', 'surfacing facts must be an object.');
  }
  const event = input.event == null ? {} : input.event;
  if (typeof event !== 'object' || Array.isArray(event)) {
    return fail('invalid_input', 'surfacing event must be an object.');
  }
  const origin = event.origin ?? 'user_request';
  const kind = event.kind ?? 'result';
  const severity = event.severity ?? 'info';
  const novelty = event.novelty ?? true;
  const proactivity = input.proactivity ?? 'normal';
  const foreground = input.foreground ?? true;
  const quietHours = input.quietHours ?? false;
  const needsYou = input.needsYou ?? false;
  if (!ORIGINS.has(origin) || !EVENT_KINDS.has(kind) || !SEVERITIES.has(severity) || !PROACTIVITY.has(proactivity)) {
    return fail('invalid_input', 'surfacing facts are invalid.');
  }
  if (typeof novelty !== 'boolean' || typeof foreground !== 'boolean' || typeof quietHours !== 'boolean' || typeof needsYou !== 'boolean') {
    return fail('invalid_input', 'surfacing facts are invalid.');
  }
  const decision = planDelivery({
    event: {
      origin,
      kind,
      novelty,
      severity,
      ...(event.deadlineImminent === true ? { deadlineImminent: true } : {}),
    },
    proactivity,
    foreground,
    quietHours,
    needsYou,
  });
  return { ok: true, decision: decision.decision };
}

function indexVerdicts(verdicts) {
  const bySession = new Map();
  for (const verdict of Array.isArray(verdicts) ? verdicts : []) {
    if (!verdict || typeof verdict !== 'object') continue;
    const sessionId = boundedId(verdict.sessionId, ID_MAX);
    if (!sessionId || !OUTCOMES.has(verdict.outcome)) continue;
    const verdictRef = boundedId(verdict.verdictRef, ID_MAX) || `verdict:${sessionId}`;
    const computedAt = typeof verdict.computedAt === 'string' ? verdict.computedAt : '';
    bySession.set(sessionId, { sessionId, outcome: verdict.outcome, verdictRef, computedAt });
  }
  return bySession;
}

function marksFor(sources, bySession) {
  const marks = [];
  for (const sessionId of sources) {
    const verdict = bySession.get(sessionId);
    if (!verdict) continue;
    marks.push({
      sessionId,
      outcome: verdict.outcome,
      verdictRef: verdict.verdictRef,
    });
  }
  return marks;
}

function latestVerdictRef(sources, bySession) {
  let latest = null;
  for (const sessionId of sources) {
    const verdict = bySession.get(sessionId);
    if (!verdict) continue;
    if (!latest || verdict.computedAt > latest.computedAt) latest = verdict;
  }
  return latest ? latest.verdictRef : '';
}

function learnedFromTools(toolCalls) {
  const ids = [];
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const name = call?.name || call?.toolName;
    if (name !== 'memory_remember') continue;
    const result = call?.result && typeof call.result === 'object' ? call.result : {};
    const output = result.output && typeof result.output === 'object' ? result.output : {};
    const raw = result.id ?? result.memoryId ?? output.id ?? output.memoryId;
    const id = boundedId(raw, ID_MAX);
    if (id) ids.push(id);
  }
  return ids;
}

function mergeIds(left, right) {
  const ids = [];
  const seen = new Set();
  for (const id of [...left, ...right]) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
