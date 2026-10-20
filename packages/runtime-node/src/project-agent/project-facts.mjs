import { projectReplyQuestions } from './question-lifecycle.mjs';
import { createCardProjection } from './card-projection.mjs';
import { verdictRefFor } from './acceptance.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { replyFailureStatus } from './reply-failure-facts.mjs';
import { replyRecoveryAdmission } from './reply-recovery-admission.mjs';
import { workBudgetBinding } from './work-budget.mjs';
import { pathOf } from '../data-store.mjs';
import path from 'node:path';

/** Project facts shared by reply validation and cards; model payloads never supply verdicts. */
export function createDesktopProjectFacts({ supervisor, approvalStore, profileStore, conversationStore, runtimeRoot, memoryStore = null, objectiveProposals=()=>[],
  readCoordination, now = () => new Date().toISOString(),
  readCoordinationCheckpoint = null }) {
  const projection = createCardProjection({ rootDir: runtimeRoot });
  const readers = new Map();
  const storeFor = workspaceId => {
    const file = path.join(runtimeRoot || pathOf('projectRuntime'), workspaceId, 'coordination.jsonl');
    const owner = workBudgetBinding(workspaceId)?.store;
    if (owner?.journalFile === file) return owner;
    const reader = readers.get(workspaceId) || createWorkCoordinationStore({ rootDir: runtimeRoot, workspaceId });
    readers.delete(workspaceId); readers.set(workspaceId, reader);
    if (readers.size > 16) readers.delete(readers.keys().next().value);
    return reader;
  };
  const coordinationFor = workspaceId => readCoordination ? readCoordination(workspaceId) : storeFor(workspaceId).read();
  const checkpointFor = (workspaceId, ref) => readCoordinationCheckpoint
    ? readCoordinationCheckpoint(workspaceId, ref) : storeFor(workspaceId).readRecoveryCheckpoint(ref);
  const messageFacts = typeof conversationStore.createHistoryProjection === 'function'
    ? conversationStore.createHistoryProjection(history => history.messages.map(message => message.kind === 'agent_turn'
      ? { id: message.id, kind: message.kind, meta: message.meta, turnKind: message.turnKind }
      : (({ attachments, ...fact }) => fact)(message)), { immutableInput: true })
    : id => conversationStore.getPersistedConversationHistory(id)?.messages || [];
  function sessions(workspaceId) { return supervisor.sessionsForProject(workspaceId); }
  function delivery(workspaceId) {
    const rows = sessions(workspaceId);
    const profile = profileStore.read(workspaceId);
    const messages = messageFacts(profile?.agentConversationId) || [];
    return {
      reportedMessages: messages.filter(message => message.kind === 'agent_reply'),
      sessionIds: rows.map((row) => row.sessionId),
      sessionStates: rows.map((row) => ({ sessionId: row.sessionId, status: row.status, sourceRevision: row.sourceRevision,
        ...(row.observationRevision ? { observationRevision: row.observationRevision } : {}) })),
      unreportedResults: rows.filter(row => row.status === 'result_ready'
        && !messages.some(message => message.kind === 'agent_reply' && message.sources?.includes(row.sessionId)
          && message.meta?.sessionStates?.some(state => state.sessionId === row.sessionId
            && state.sourceRevision === row.sourceRevision && state.observationRevision === row.observationRevision
            && ['result_ready', 'accepted'].includes(state.status))))
        .map(row => ({sessionId:row.sessionId,anchorMessageId:row.origin?.anchorMessageId})),
      verdicts: rows.flatMap((row) => {
        const decision = supervisor.acceptance(row.sessionId);
        return decision ? [{ sessionId: row.sessionId, ...decision.verdict,
          verdictRef: verdictRefFor(row.sessionId, decision.verdict.outcome) }] : [];
      }),
    };
  }
  function cards(workspaceId) {
    const profile = profileStore.read(workspaceId);
    const messages = messageFacts(profile?.agentConversationId) || [];
    const questionStates = projectReplyQuestions(messages, Date.parse(now()));
    const replies = messages.filter((message) => message.kind === 'agent_reply').map((message) => ({
      ...message,
      ...(message.question ? { question: { ...message.question,
        answered: questionStates.get(message.id)?.state !== 'open', state: questionStates.get(message.id)?.state } } : {}),
    }));
    const rows = sessions(workspaceId);
    const confirmations = rows.flatMap((row) => {
      const decision = supervisor.acceptance(row.sessionId);
      return decision && (row.status === 'result_ready' && row.resultConfirmationRequired === true || row.status === 'accepted')
        ? [{ sessionId: row.sessionId, summary: row.title, accepted: row.status === 'accepted' }] : [];
    });
    const completionReviews = rows.flatMap(row => {
      const review = supervisor.completionReview?.(row.sessionId);
      return review ? [{ ...review, title: row.title }] : [];
    });
    const questions = rows.flatMap((row) => {
      if (row.status !== 'waiting_user') return [];
      if (['dependency_failed', 'dependency_missing'].includes(row.queueReason)) {
        const questionId = 'dependency';
        const answerTo = `card:question:${row.sessionId}:${questionId}`;
        return [{ sessionId: row.sessionId, questionId,
          prompt: `「${row.title}」的前置任务未成功签收。要取消还是重新安排？`,
          options: ['取消这个任务', '重新安排任务'],
          answered: messages.some(answer => answer.answerTo === answerTo),
        }];
      }
      const history = conversationStore.getPersistedConversationHistory(row.conversationId)?.messages || [];
      return history.flatMap((message) => (message.segments || []).flatMap((segment) => {
        if (segment.tool !== 'request_user_input' || !segment.args) return [];
        const args = segment.args;
        return [{ sessionId: row.sessionId, questionId: segment.toolCallId || message.id,
          prompt: args.question || args.prompt,
          options: (args.options || []).map((option) => typeof option === 'string' ? option : option.label),
        }];
      })).slice(-1);
    });
    const coordination = coordinationFor(workspaceId) || {};
    const works = Object.values(coordination.works || {});
    const unavailable = messages.filter((message) => message.card === 'agent_unavailable').map((message) => {
      const turn = messages.find(turn => turn.id === message.turnId && turn.kind === 'agent_turn');
      const work = works.find(work => work.workId === (message.meta?.workId || turn?.meta?.workId))
        || works.find(work => work.recovery?.failedTurnId === message.turnId || work.attemptId === message.turnId);
      const failureStatus = replyFailureStatus(message, messages, works, coordination.deliveries || {}, rows, now());
      const superseded = ['superseded', 'recovered', 'cancelled', 'paused'].includes(failureStatus.phase);
      let checkpoint;
      const terminal = ['delivered', 'cancelled', 'waiting_user', 'coalesced'].includes(work?.state);
      try { if (!superseded && !terminal && work?.checkpointRef) checkpoint = checkpointFor(workspaceId, work.checkpointRef); } catch { /* admission reports unavailable */ }
      const admission = superseded || terminal ? { ok: false, code: 'STALE_TURN' }
        : replyRecoveryAdmission(work, checkpoint, { limits: workBudgetBinding(workspaceId)?.limits,
          readCheckpoint: ref => checkpointFor(workspaceId, ref) });
      const recoveryAction = { canContinue: !superseded && admission.ok,
        ...(!admission.ok ? { blockedReason: admission.code } : {}), ...(admission.budget ? { budget: admission.budget } : {}) };
      let recovery = !superseded ? work?.recovery : undefined;
      if (recovery?.reservationId && (work.state !== 'retry_wait'
        || !work.waitFor?.some(wait => wait.kind === 'retry_timer' && wait.id === recovery.reservationId)
        || Date.parse(recovery.deadlineAt) <= Date.parse(now()))) {
        recovery = { ...recovery, retryAt: undefined, reservationId: undefined };
      }
      return { turnId: message.turnId, reason: message.content?.replace(/^代理暂时不可用：/, ''), superseded,
        recovery, recoveryWorkState: work?.state, failureStatus, recoveryAction };
    });
    const stopped = messages.filter(message => message.card === 'agent_stopped').map(message => ({
      turnId: message.turnId, text: message.content,
      superseded: messages.slice(messages.indexOf(message) + 1).some(later => later.kind === 'agent_turn'),
    }));
    return projection.project(workspaceId, { approvals: approvalStore.list({ workspaceId }),
      objectiveProposals:objectiveProposals(workspaceId), confirmations, completionReviews, questions, replies, readmeOffer: profile?.readmeOffer, unavailable, stopped,
      memories: memoryStore?.list({ workspaceId }) || [],
      handoffs: rows.flatMap(row => { const facts = supervisor.deliveryFacts?.(row.sessionId); return facts ? [facts] : []; }) });
  }
  const query = read => typeof supervisor.readQuery === 'function' ? supervisor.readQuery(read) : read();
  return { delivery: id => query(() => delivery(id)), cards: id => query(() => cards(id)),
    resolve: (workspaceId, cardId) => projection.resolve(workspaceId, cardId, { resolution: 'retried' }) };
}
