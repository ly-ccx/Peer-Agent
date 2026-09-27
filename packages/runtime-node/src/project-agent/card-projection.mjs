/**
 * 卡片只从宿主事实投影。同一事实得到同一 cardId。
 * 解决状态追加在 project-runtime/<workspaceId>/cards.jsonl，按 cardId 折叠，后写的覆盖先写的。
 * 宿主事实已经终态时，不必另写一条也能投影成已解决。
 * 确认结果的通道属于签收实现，这里只留下动作载荷，不登记 IPC。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathOf } from '../data-store.mjs';

const WORKSPACE_DIR = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ID_MAX = 200;
const CARD_ID_MAX = 500;
const TEXT_MAX = 240;
const CLOSED_APPROVAL = new Set(['approved', 'denied', 'expired']);

/**
 * 纯投影。resolutions 是已经折叠前的追加记录，后出现的覆盖先出现的。
 */
export function projectCards(workspaceId, facts = {}, resolutions = []) {
  assertWorkspace(workspaceId);
  const stored = foldResolutions(resolutions);
  const built = [
    ...approvalCards(facts),
    ...planApprovalCards(facts),
    ...taskQuestionCards(facts),
    ...replyQuestionCards(facts),
    ...confirmCards(facts),
    ...readmeCards(workspaceId, facts),
    ...unavailableCards(facts),
  ];
  const byId = new Map();
  for (const card of built) {
    if (!card || byId.has(card.cardId)) continue;
    byId.set(card.cardId, card);
  }
  return [...byId.values()]
    .map((card) => applyResolution(card, stored.get(card.cardId)))
    .sort((left, right) => (left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0));
}

/**
 * @param {{ rootDir?: string | null, now?: () => Date | string }} [options]
 */
export function createCardProjection({ rootDir = null, now = () => new Date() } = {}) {
  function root() {
    return rootDir || pathOf('projectRuntime');
  }

  function fileFor(workspaceId) {
    assertWorkspace(workspaceId);
    return path.join(root(), workspaceId, 'cards.jsonl');
  }

  function readResolutions(workspaceId) {
    const file = fileFor(workspaceId);
    if (!existsSync(file)) return [];
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const records = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = normalizeRecord(JSON.parse(line));
        if (record) records.push(record);
      } catch {
        // 坏行跳过，不让一行损坏挡住其余事实。
      }
    }
    return records;
  }

  function project(workspaceId, facts = {}) {
    return projectCards(workspaceId, facts, readResolutions(workspaceId));
  }

  function resolve(workspaceId, cardId, state = {}) {
    const record = normalizeResolution(cardId, state, timestamp(now));
    const file = fileFor(workspaceId);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  return { project, resolve };
}

function isPlanApproval(approval) {
  return approval?.kind === 'plan_approval' || approval?.capabilityId === 'goal.plan';
}

function approvalCards(facts) {
  const cards = [];
  for (const approval of asList(facts.approvals)) {
    if (isPlanApproval(approval)) continue;
    const approvalId = boundedId(approval?.approvalId, ID_MAX);
    if (!approvalId) continue;
    const state = typeof approval.state === 'string' ? approval.state : 'open';
    if (state !== 'open' && state !== 'stale' && !CLOSED_APPROVAL.has(state)) continue;
    const closed = CLOSED_APPROVAL.has(state);
    const cardId = cardIdOf('approval', approvalId);
    cards.push(draft({
      cardId,
      kind: 'approval',
      content: approvalContent(approval),
      factResolved: closed,
      factState: closed ? state : '',
      actions: closed ? [] : approvalActions(approvalId, state),
      refs: approvalRefs(approval, approvalId),
    }));
  }
  return cards;
}

function planApprovalCards(facts) {
  const cards = [];
  for (const approval of [...asList(facts.planApprovals), ...asList(facts.approvals).filter(isPlanApproval)]) {
    const approvalId = boundedId(approval?.approvalId, ID_MAX);
    const sessionId = boundedId(approval?.sessionId, ID_MAX);
    if (!approvalId && !sessionId) continue;
    const state = typeof approval.state === 'string' ? approval.state : 'open';
    if (state !== 'open' && state !== 'stale' && !CLOSED_APPROVAL.has(state)) continue;
    const closed = CLOSED_APPROVAL.has(state);
    const cardId = cardIdOf('plan_approval', approvalId || sessionId);
    cards.push(draft({
      cardId,
      kind: 'plan_approval',
      content: clip(approval.summary, '计划待批准'),
      factResolved: closed,
      factState: closed ? state : '',
      actions: closed ? [] : [
        action('approve', 'project-agent:decide-approval', { approvalId: approvalId || sessionId, decision: 'approve' }),
        action('reject', 'project-agent:decide-approval', { approvalId: approvalId || sessionId, decision: 'reject', duration: 'denied' }),
      ],
      refs: approvalRefs(approval, approvalId || sessionId),
    }));
  }
  return cards;
}

function approvalContent(approval) {
  const summary = clip(approval.summary, '需要你批准');
  const extra = [approval.capabilityId, approval.riskLevel, approval.taskName]
    .map((item) => boundedId(item, ID_MAX))
    .filter(Boolean);
  if (extra.length === 0) return summary;
  return clip(`${summary} · ${extra.join(' · ')}`, summary);
}

function approvalActions(approvalId, state) {
  if (state === 'stale') {
    return [action('continue', 'project-agent:decide-approval', { approvalId, decision: 'approve', duration: 'once' })];
  }
  return [
    action('allow', 'project-agent:decide-approval', { approvalId, decision: 'approve', duration: 'once' }),
    action('allow_task', 'project-agent:decide-approval', { approvalId, decision: 'approve', duration: 'task' }),
    action('reject', 'project-agent:decide-approval', { approvalId, decision: 'reject', duration: 'denied' }),
  ];
}

function approvalRefs(approval, approvalId) {
  return refs({
    approvalId,
    sessionId: boundedId(approval.sessionId, ID_MAX),
    capabilityId: boundedId(approval.capabilityId, ID_MAX),
    riskLevel: boundedId(approval.riskLevel, ID_MAX),
    taskName: boundedId(approval.taskName, ID_MAX),
  });
}

function taskQuestionCards(facts) {
  const cards = [];
  for (const question of asList(facts.questions)) {
    const sessionId = boundedId(question?.sessionId, ID_MAX);
    const questionId = boundedId(question?.questionId, ID_MAX);
    if (!sessionId || !questionId) continue;
    const cardId = cardIdOf('question', `${sessionId}:${questionId}`);
    const answered = question.answered === true || question.state === 'answered';
    cards.push(draft({
      cardId,
      kind: 'question',
      content: clip(question.prompt, '需要你回答'),
      factResolved: answered,
      factState: answered ? 'answered' : '',
      actions: answerActions(cardId, question.options),
      refs: refs({ sessionId, questionId }),
    }));
  }
  return cards;
}

function replyQuestionCards(facts) {
  const cards = [];
  for (const question of [...asList(facts.replyQuestions), ...questionsOnReplies(facts.replies)]) {
    const replyMessageId = boundedId(question?.replyMessageId, ID_MAX);
    if (!replyMessageId) continue;
    const cardId = cardIdOf('question', `reply:${replyMessageId}`);
    const answered = question.answered === true || question.state === 'answered';
    cards.push(draft({
      cardId,
      kind: 'question',
      content: clip(question.prompt, '需要你回答'),
      factResolved: answered,
      factState: answered ? 'answered' : '',
      actions: answerActions(cardId, question.options),
      refs: refs({ replyMessageId }),
    }));
  }
  return cards;
}

function questionsOnReplies(replies) {
  const questions = [];
  for (const reply of asList(replies)) {
    if (!reply?.question || typeof reply.question !== 'object') continue;
    questions.push({
      replyMessageId: reply.id || reply.messageId,
      options: reply.question.options,
      prompt: reply.question.prompt,
      answered: reply.question.answered === true,
    });
  }
  return questions;
}

function confirmCards(facts) {
  const cards = [];
  for (const confirmation of asList(facts.confirmations)) {
    if (confirmation?.needsConfirm === false) continue;
    const sessionId = boundedId(confirmation?.sessionId, ID_MAX);
    if (!sessionId) continue;
    const cardId = cardIdOf('confirm_result', sessionId);
    const accepted = confirmation.accepted === true;
    cards.push(draft({
      cardId,
      kind: 'confirm_result',
      content: clip(confirmation.summary, '需要你确认结果'),
      factResolved: accepted,
      factState: accepted ? 'accepted' : '',
      actions: accepted ? [] : [seamAction('confirm', 'b2-09', { sessionId, cardId, acceptedBy: 'user' })],
      refs: refs({ sessionId }),
    }));
  }
  return cards;
}

function readmeCards(workspaceId, facts) {
  const offer = readmeFact(facts.readmeOffer);
  if (!offer) return [];
  const cardId = cardIdOf('readme_offer', workspaceId);
  return [draft({
    cardId,
    kind: 'readme_offer',
    content: '要不要为这个项目写一份 README',
    factResolved: offer.accepted,
    factState: offer.accepted ? 'accepted' : '',
    actions: offer.accepted ? [] : [seamAction('accept_readme', 'b2-12', { workspaceId, cardId })],
    refs: refs({ workspaceId }),
  })];
}

function unavailableCards(facts) {
  const cards = [];
  for (const item of asList(facts.unavailable)) {
    const turnId = boundedId(item?.turnId, ID_MAX);
    if (!turnId) continue;
    const cardId = cardIdOf('agent_unavailable', turnId);
    const reason = clip(item.reason, '未知原因');
    cards.push(draft({
      cardId,
      kind: 'agent_unavailable',
      content: `代理暂时不可用：${reason}`,
      factResolved: false,
      factState: '',
      actions: [seamAction('retry', 'runner.retry', { turnId, cardId })],
      refs: refs({ turnId }),
    }));
  }
  return cards;
}

function readmeFact(value) {
  if (value === true) return { accepted: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.offered === false || value.pending === false) return null;
  if (value.accepted === true) return { accepted: true };
  if (value.offered === true || value.pending === true || value.blank === true) return { accepted: false };
  return null;
}

function answerActions(cardId, options) {
  const choices = [];
  const seen = new Set();
  for (const option of Array.isArray(options) ? options : []) {
    const text = boundedId(option, ID_MAX);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    choices.push(text);
  }
  if (choices.length === 0) {
    return [action('answer', 'project-agent:submit-input', { answerTo: cardId })];
  }
  return choices.map((text) => action('answer', 'project-agent:submit-input', { answerTo: cardId, text }));
}

function draft(card) {
  if (!card.cardId) return null;
  return card;
}

function applyResolution(card, stored) {
  const storeResolved = stored?.resolvedState === 'resolved';
  const resolved = card.factResolved || storeResolved;
  const resolution = card.factResolved
    ? { source: 'fact', state: card.factState }
    : storeResolved
      ? { source: 'store', state: stored.resolution || 'resolved', ...(stored.at ? { at: stored.at } : {}) }
      : null;
  return {
    cardId: card.cardId,
    kind: card.kind,
    resolvedState: resolved ? 'resolved' : 'open',
    ...(resolution ? { resolution } : {}),
    content: card.content,
    actions: resolved ? [] : card.actions,
    refs: card.refs,
  };
}

function action(id, channel, payload) {
  return { id, channel, payload };
}

function seamAction(id, seam, payload) {
  return { id, seam, payload };
}

function refs(fields) {
  const value = {};
  for (const [key, item] of Object.entries(fields)) {
    if (typeof item === 'string' && item) value[key] = item;
  }
  return value;
}

function cardIdOf(kind, suffix) {
  const cardId = `card:${kind}:${suffix}`;
  return cardId.length <= CARD_ID_MAX ? cardId : '';
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

function clip(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, TEXT_MAX);
}

function boundedId(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\r\n]/.test(trimmed)) return '';
  return trimmed;
}

function foldResolutions(records) {
  const byId = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const normalized = normalizeRecord(record);
    if (!normalized) continue;
    byId.set(normalized.cardId, normalized);
  }
  return byId;
}

function normalizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const cardId = boundedId(input.cardId, CARD_ID_MAX);
  if (!cardId) return null;
  if (input.resolvedState !== 'open' && input.resolvedState !== 'resolved') return null;
  const at = typeof input.at === 'string' ? input.at : '';
  const resolution = typeof input.resolution === 'string' ? input.resolution : '';
  return { cardId, resolvedState: input.resolvedState, at, resolution };
}

function normalizeResolution(cardId, state, at) {
  const id = boundedId(cardId, CARD_ID_MAX);
  if (!id) throw new Error('invalid_card');
  const resolvedState = state === 'open' || state === 'resolved'
    ? state
    : state?.resolvedState === 'open'
      ? 'open'
      : 'resolved';
  const resolution = typeof state === 'object' && state && typeof state.resolution === 'string'
    ? state.resolution.trim().slice(0, TEXT_MAX)
    : resolvedState;
  return {
    cardId: id,
    resolvedState,
    at,
    ...(resolution ? { resolution } : {}),
  };
}

function assertWorkspace(workspaceId) {
  if (typeof workspaceId !== 'string' || !WORKSPACE_DIR.test(workspaceId)) {
    throw new Error('invalid_workspace');
  }
}

function timestamp(now) {
  const value = now();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value.trim();
  return new Date().toISOString();
}
