/**
 * 卡片只从宿主事实投影。同一事实得到同一 cardId。
 * 解决状态追加在 project-runtime/<workspaceId>/cards.jsonl，按 cardId 折叠，后写的覆盖先写的。
 * 宿主事实已经终态时，不必另写一条也能投影成已解决。
 * 动作载荷由应用服务执行；事实和持久化解决状态决定是否仍可操作。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathOf } from '../data-store.mjs';
import { formatGoalDeliveryHandoff } from '@peer-agent/protocol';

const WORKSPACE_DIR = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ID_MAX = 200;
const CARD_ID_MAX = 500;
const TEXT_MAX = 240;
const CLOSED_APPROVAL = new Set(['approved', 'denied', 'expired']);

/** Conversational choices only. Legacy freeform answers do not approve task or permission cards. */
export function replyQuestionAnswered(messages, reply) {
  if (reply?.question?.answered === true) return true;
  const index = messages.indexOf(reply);
  if (index < 0 || !reply?.id) return false;
  const cardId = `card:question:reply:${reply.id}`;
  const later = messages.slice(index + 1);
  const isUser = message => message?.kind === 'user_input' || (!message?.kind && message?.role === 'user');
  if (later.some(message => isUser(message) && message.answerTo === cardId)) return true;
  const next = later.find(message => isUser(message) || message?.kind === 'agent_reply'
    || (!message?.kind && message?.role === 'assistant'));
  return Boolean(next && isUser(next) && !next.answerTo
    && (!Array.isArray(next.quoteRefs) || next.quoteRefs.length === 0 || next.quoteRefs.includes(reply.id)));
}

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
    ...completionReviewCards(facts),
    ...readmeCards(workspaceId, facts),
    ...unavailableCards(facts),
    ...stoppedCards(facts),
    ...memoryConflictCards(facts),
    ...handoffCards(facts),
    ...objectiveProposalCards(facts),
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

function handoffCards(facts) {
  return asList(facts.handoffs).filter(row => row.status === 'completed' && row.accepted && row.worktreePath
    && !['delivered', 'delivering'].includes(row.handoff?.status)).map(row => {
    const conflict = row.conflict === true;
    const reason = formatGoalDeliveryHandoff({ deliveryHandoff: row.handoff,
      deliveryBinding: { executionIsolation: 'worktree' } });
    const questionId = row.questionId || 'handoff';
    const cardId = cardIdOf('question', `${row.sessionId}:${questionId}`);
    return draft({ cardId, kind: 'question',
      content: conflict ? `「${row.title}」${reason || '合回未成功'}。要让任务处理、自己处理，还是放弃？`
        : `「${row.title}」已签收。要把改动合回项目吗？`,
      factResolved: row.deferred === true, factState: row.deferred ? 'deferred' : '',
      actions: answerActions(cardId, conflict ? ['让任务自己解决', '我来处理', '放弃这次改动'] : ['合回改动', '暂不合回']),
      refs: refs({ sessionId: row.sessionId, questionId }),
    });
  });
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
      actions: accepted ? [] : [ipcAction('confirm', 'project-agent:confirm-result', { sessionId, cardId, acceptedBy: 'user' })],
      refs: refs({ sessionId }),
    }));
  }
  return cards;
}

function completionReviewCards(facts) {
  return asList(facts.completionReviews).filter(review => review?.reviewToken && review.report && review.criteria?.length).map(review => draft({
    cardId: cardIdOf('completion_review', `${review.sessionId}:${review.reviewToken}`),
    kind: 'completion_review', content: clip(review.title, '核对报告'), completionReview: review,
    factResolved: false, factState: '', refs: refs({ sessionId: review.sessionId }),
    actions: [ipcAction(review.confirmed ? 'retry_completion' : 'confirm_completion', 'project-agent:confirm-result', {
      sessionId: review.sessionId, stage: 'manual_completion', reviewToken: review.reviewToken,
    })],
  }));
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
    actions: offer.accepted ? [] : [ipcAction('accept_readme', 'project-agent:accept-readme', { workspaceId, cardId })],
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
      factResolved: item.superseded === true,
      factState: item.superseded === true ? 'superseded' : '',
      actions: item.superseded === true ? [] : [ipcAction('retry', 'project-agent:retry', { turnId, cardId })],
      refs: refs({ turnId }),
      ...(item.recovery ? { recovery: item.recovery, recoveryWorkState: item.recoveryWorkState } : {}),
    }));
  }
  return cards;
}

function stoppedCards(facts) {
  return asList(facts.stopped).flatMap(item => {
    const turnId = boundedId(item?.turnId, ID_MAX);
    if (!turnId) return [];
    const cardId = cardIdOf('agent_stopped', turnId);
    return [draft({ cardId, kind: 'agent_stopped', content: typeof item.text === 'string' ? item.text.slice(0, 32_000) : '',
      factResolved: item.superseded === true, factState: item.superseded ? 'superseded' : '',
      actions: item.superseded ? [] : [ipcAction('retry', 'project-agent:retry', { turnId, cardId })], refs: refs({ turnId }) })];
  });
}

function memoryConflictCards(facts) {
  const groups = new Map();
  for (const item of asList(facts.memories)) {
    if (item.status !== 'conflicted' || !boundedId(item.conflictId, ID_MAX)) continue;
    const group = groups.get(item.conflictId) || []; group.push(item); groups.set(item.conflictId, group);
  }
  return [...groups].flatMap(([conflictId, items]) => items.length < 2 ? [] : [draft({
    cardId: cardIdOf('memory_conflict', conflictId), kind: 'memory_conflict',
    content: clip(`记忆有冲突，请选择保留哪条：${items.slice(0, 2).map(item => `${item.text.slice(0, 70)}（来源：${(item.sourceRefs || []).join('、').slice(0, 20)}）`).join('；')}`, '记忆冲突，需要选择'),
    factResolved: false, factState: '', refs: refs({ conflictId }),
    actions: items.slice(0, 4).map(item => ipcAction('choose_memory', 'project-memory:restore', {
      id: item.id, resolveConflict: true, text: clip(`保留：${item.text}`, '保留这条'),
    })),
  })]);
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
  // Older hosts could resolve a retry when disposal merely ended its wait.
  // Keep that receipt, but require the subsequent canonical turn to back it.
  const unsupportedRetry = stored?.resolution === 'retried' && !card.factResolved
    && ['agent_unavailable', 'agent_stopped'].includes(card.kind);
  const storeResolved = stored?.resolvedState === 'resolved' && !unsupportedRetry;
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
    ...(card.completionReview ? { completionReview: card.completionReview } : {}),
    ...(!resolved && card.recovery ? { recovery: card.recovery, recoveryWorkState: card.recoveryWorkState } : {}),
    actions: resolved ? [] : card.actions,
    refs: card.refs,
  };
}

function action(id, channel, payload) {
  return { id, channel, payload };
}

function ipcAction(id, channel, payload) {
  return { id, channel, payload };
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

function objectiveProposalCards(facts){return asList(facts.objectiveProposals).filter(row=>row.state==='proposed').map(row=>{const cardId=cardIdOf('question',`objective:${row.actionId}`);return draft({cardId,kind:'question',content:clip(`「${row.input.title}」：${row.input.brief}。要开始这个任务吗？`,'要开始目标任务吗？'),factResolved:false,factState:'',actions:answerActions(cardId,['开始','暂不']),refs:refs({objectiveId:row.objectiveId,objectiveActionId:row.actionId})});});}
