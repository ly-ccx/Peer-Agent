import { controlProjectWork } from './work-control.mjs';
import { createSessionCancellation } from './session-cancellation.mjs';
import { createSessionTakeover } from './session-takeover.mjs';
import { createCoordinationLifecycle } from './coordination-lifecycle.mjs';
import { sessionExecutionCurrent } from './execution-ownership.mjs';
import { workBudgetBinding } from './work-budget.mjs';
import { createAgentCommunication } from './agent-communication.mjs';
import { createLegacyCriterionRecovery } from './criterion-recovery.mjs';
import { verificationContentHash } from './verification-completion.mjs';
import { sessionFactsFromPlan } from './session-facts.mjs';
import { admitDelegationCriteria } from './criterion-authority.mjs';
import { isHostHandoffPause } from './session-host-handoff.mjs';
import { hasCurrentUserUrgency } from './user-priority.mjs';
import path from 'node:path';
import { createExecutionScheduler } from './execution-scheduler.mjs';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';

import { projectWorkSession, resolveRoleModel } from '@peer-agent/protocol';

import { canConsumeRequestedUserInput } from '../goal-plan-store.mjs';
import { normalizeInputAttachments } from './input-queue.mjs';
import { createSnapshot } from '../memory/memory-snapshot.mjs';
import { decideSessionAcceptance } from './acceptance.mjs';
import { createSessionContinuity } from './session-continuity.mjs';
import { createSessionHandoff } from './session-handoff.mjs';
import { digestApprovalArgs } from './approval-store.mjs';
import { readLocalPlanApproval } from './local-plan-approval.mjs';
import { spawnIdentity, identityFromPlan } from './spawn-identity.mjs';
import { buildSessionReport } from './session-report.mjs';
import { resultCanBeAccepted, needsCompletionReview, projectCompletionReview, confirmCompletionReview } from './session-completion.mjs';

/**
 * 开任务：冻结模型 → 子会话 → 委托消息 → GoalPlan → 排队或启动。
 * ExecutionScheduler 负责槽位、优先级与依赖；监督者只持久化准入并启动 Runner。
 * 只读写入判定在 evaluateWorkSessionWrite。协议里的 writeScope 只有 workspace_and_boundaries，不能用来表示禁止写。
 * 开任务时把当时的 active 记忆 id 冻成 memorySnapshotId。
 * 事件 kind 用 session_started / cancelled，收件箱映射留给 B2-05。
 * spawn(input, context)。调度端口把父会话、工作区和可选的历史背景快照一并传进来。
 * message intent amend 写入「来自项目代理转达：用户说……」。
 * 任务正在等用户时，这句话就是回答，并恢复执行。
 * 任务仍在跑时，只写入子会话和一条 user_correction，下一回合开始时生效，不取消未完成任务。
 * 聊天表面的纠正路由会收尾剩余工作，并入不能走那条取消。
 * spawn 带 supersedes 时先建好新会话，再停旧会话，并且不把名额让给更早的排队任务。
 * 新会话没建成时，旧会话保持原状。已经结束的会话不能 amend。
 * settle 在任务完成后计算结论。只有代理回复已经引用该任务、策略允许、关闭闸门通过，才写入代签。
 */

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const WRITE_CAPABILITIES = new Set(['local.file.write', 'local.file.edit', 'local.shell.exec']);
const WRITE_KINDS = new Set(['file-write', 'shell']);
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'bash']);
const READ_ONLY_CAPABILITIES = new Set([
  'local.file.read', 'local.file.list', 'local.file.search', 'local.search.aggregate', 'local.image.read',
  'local.goal.get_plan', 'local.goal.update_task', 'local.goal.revise_plan',
  'local.goal.record_evidence', 'local.interaction.request_user_input',
  'local.goal.explore',
  'local.delegation.send_agent_message',
]);
const ROLE_SLOTS = [
  ['session_worker', 'worker'],
  ['explorer', 'explorer'],
  ['verifier', 'verifier'],
  ['visual_verifier', 'visualVerifier'],
];

export function evaluateWorkSessionWrite(plan, action = {}) {
  if (!sessionExecutionCurrent(plan)) return { allowed: false, error: 'work_execution_stopped' };
  if (plan?.delegationOrigin?.readOnly !== true) return { allowed: true };
  const capabilityId = typeof action.capabilityId === 'string' ? action.capabilityId : '';
  const permissionKind = typeof action.permissionKind === 'string' ? action.permissionKind : '';
  const toolName = typeof action.toolName === 'string'
    ? action.toolName
    : (typeof action.name === 'string' ? action.name : '');
  const writing = WRITE_CAPABILITIES.has(capabilityId)
    || WRITE_KINDS.has(permissionKind)
    || WRITE_TOOLS.has(toolName);
  // Bookkeeping of task facts and loading Skill text do not execute project mutations.
  const reading = READ_ONLY_CAPABILITIES.has(capabilityId) || capabilityId.startsWith('local.skill.')
    || (capabilityId.startsWith('local.mcp.') && ['L0_inert', 'L1_local_read'].includes(action.riskLevel));
  if (!writing && reading) return { allowed: true };
  return { allowed: false, error: 'read_only', message: '只读任务不能写入。' };
}

export function resolvePlanApproval(policy, input = {}) {
  const mode = policy === 'always' || policy === 'writes' ? policy : 'never';
  if (mode === 'always') return true;
  if (mode === 'writes') return input?.readOnly !== true;
  return false;
}

export function createSessionSupervisor({
  conversationStore,
  goalPlanStore,
  goalRunner = null,
  objectives = null,
  executionScheduler = goalRunner?.executionScheduler ?? null,
  isolationPlanner = goalRunner?.isolationPlanner ?? null,
  canManageWorkspace = () => true,
  catalog = [],
  resolveModel = null,
  memoryStore = null,
  routing = null,
  projectPolicy = null,
  abortStream = null,
  deferRecovery = false,
  emitEvent = null,
  resolveAcceptancePolicy = null,
  readSessionFacts = null,
  approvalStore = null,
  readPlanApproval = null,
  readManualCriterionAuthorities = null,
  readLegacyCriterionProvenance = () => null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!conversationStore || !goalPlanStore) {
    throw new Error('createSessionSupervisor requires conversationStore and goalPlanStore');
  }

  executionScheduler ??= createExecutionScheduler({ rootDir: path.join(path.dirname(goalPlanStore.getStoreDir()), 'project-runtime'), now });
  const communication = createAgentCommunication({ conversationStore, goalPlanStore, goalRunner, findSession: findBySession,
    listSessions: delegatedPlans, canManageWorkspace, emitEvent, now });
  const handoff = createSessionHandoff({ findBySession, goalPlanStore, goalRunner, canManageWorkspace, conversationStore, promote, now });
  const continuity = createSessionContinuity({ goalPlanStore, conversationStore, goalRunner, executionScheduler,
    findBySession, canManageWorkspace, abortStream, emit, now });
  const legacyCriteria = createLegacyCriterionRecovery({ store: goalPlanStore, readProvenance: readLegacyCriterionProvenance,
    holdsLease: planId => canManageWorkspace(goalPlanStore.getPlan(planId)?.delegationOrigin?.workspaceId), now });
  let tail = Promise.resolve();
  let coordination;
  let depth = 0;
  function exclusive(task) {
    const run = tail.then(() => {
      depth += 1;
      return Promise.resolve().then(task).finally(() => { depth -= 1; });
    }, () => {
      depth += 1;
      return Promise.resolve().then(task).finally(() => { depth -= 1; });
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  function emit(event) {
    if (['cancelled', 'session_resumed'].includes(event.kind)) queueMicrotask(() => { void coordination?.recover(event.workspaceId); });
    try {
      emitEvent?.({ ...event, at: event.at || now() });
    } catch {
      // 收件箱尚未接入。事件投递失败不回滚已经落盘的任务。
    }
  }

  const cancellation = createSessionCancellation({ findBySession, goalPlanStore, goalRunner, executionScheduler, canManageWorkspace,
    abortStream, isolationPlanner, exclusive, project, emit, promote, now });
  const takeover = createSessionTakeover({ findBySession, goalPlanStore, goalRunner, executionScheduler, exclusive, canManageWorkspace,
    abortStream, promote, emit, now });
  coordination = createCoordinationLifecycle({ readSession: input => get(input),
    checkTakeover: id => {
      const plan = findBySession(id);
      return plan?.runner?.status === 'waiting_user' ? 'human_decision_required'
        : plan?.resultAcceptance?.acceptedAt || ['completed','cancelled'].includes(plan?.status) ? 'session_not_running' : null;
    },
    readMessages: id => conversationStore.getPersistedConversationHistory?.(id)?.messages || [],
    spawn: (input, context) => exclusive(() => spawnLocked(input, context)), requestCancel: cancellation.request,
    send: (input, context) => exclusive(() => communication.send(input, context)), takeover: takeover.request, holdsLease: canManageWorkspace, now });

  function delegatedPlans() {
    let names = [];
    try {
      names = readdirSync(goalPlanStore.getStoreDir());
    } catch {
      return [];
    }
    const plans = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const plan = goalPlanStore.getPlan(name.slice(0, -5));
        if (plan?.delegationOrigin?.sessionId) plans.push(plan);
      } catch {
        // 目录里的非计划文件跳过。
      }
    }
    return plans;
  }

  function findBySession(sessionId) {
    if (!sessionId) return null;
    return delegatedPlans().find((plan) => plan.delegationOrigin.sessionId === sessionId) ?? null;
  }

  function findByKey(key, parentConversationId, input) {
    return delegatedPlans().find((plan) => plan.delegationOrigin.idempotencyKey === key
      || identityFromPlan(plan, parentConversationId, input) === key) ?? null;
  }

  function openPlans(workspaceId) {
    return delegatedPlans().filter((plan) => plan.delegationOrigin.workspaceId === workspaceId
      && !TERMINAL.has(plan.status)
      && (plan.delegationOrigin.phase === 'running' || plan.delegationOrigin.phase === 'queued'));
  }

  function finalFailureReleased(plan) {
    if (plan?.status !== 'interrupted') return false;
    const runner = plan.runner;
    const runnerStatus = runner?.status;
    if (runnerStatus === 'running' || runnerStatus === 'exploring' || runnerStatus === 'waiting_user') return false;
    const interruption = runner?.interruption;
    if (interruption?.recoverable === true) {
      const limit = runner?.maxRecoverableInterruptionRetries;
      const used = runner?.recoverableInterruptionCount;
      if (!Number.isFinite(limit) || !Number.isFinite(used) || used < limit) return false;
    }
    return runnerStatus === 'failed';
  }

  function occupiesRunningSlot(plan) {
    return plan?.delegationOrigin?.phase === 'running'
      && !TERMINAL.has(plan.status)
      && !finalFailureReleased(plan);
  }

  function settled(plan) {
    return TERMINAL.has(plan?.status) || finalFailureReleased(plan);
  }

  function snapshotOf(plan) {
    return {
      planId: plan.planId,
      // Completed leaves can briefly precede the manual completion gate.
      status: plan.status === 'completed' && plan.runner?.status === 'blocked'
        && plan.runner.blockedReason === 'manual_dod_confirmation_required' ? 'executing' : plan.status,
      title: typeof plan.title === 'string' ? plan.title : '',
      runnerStatus: plan.runner?.status,
      agentWaiting: Boolean(plan.delegationOrigin?.agentWaitMessageId),
      updatedAt: plan.updatedAt,
      conversationId: plan.conversationId,
      progress: plan.progress,
      interrupted: Boolean(plan.runner?.interruption),
    };
  }

  function approvalPolicy(workspaceId, context) {
    const fromContext = text(context?.planApproval);
    if (fromContext === 'never' || fromContext === 'writes' || fromContext === 'always') return fromContext;
    let fromProfile = '';
    try {
      fromProfile = text(typeof readPlanApproval === 'function' ? readPlanApproval(workspaceId) : '');
    } catch {
      fromProfile = '';
    }
    if (fromProfile === 'writes' || fromProfile === 'always') return fromProfile;
    return 'never';
  }

  function project(plan, plans = null) {
    const origin = plan.delegationOrigin;
    const conversation = conversationStore.getConversation?.(plan.conversationId);
    const session = projectWorkSession(snapshotOf(plan), {
      sessionId: origin.sessionId,
      workspaceId: origin.workspaceId || '',
      acceptance: 'confirm',
      accepted: Boolean(plan.resultAcceptance?.acceptedAt),
      spawnedAt: conversation?.createdAt || plan.createdAt || '',
      ...(typeof plan.conversationId === 'string' && plan.conversationId ? { conversationId: plan.conversationId } : {}),
      ...(sessionFactsFromPlan(plan).verificationActive ? { verifying: true } : {}),
      origin,
      ...(origin.supersededBy ? { supersededBy: origin.supersededBy } : {}),
      ...(origin.phase === 'paused' ? { phase: 'paused' } : {}),
      ...(origin.phase === 'queued'
        ? (({ queuedBehind, reason }) => ({ queuedBehind, queueReason: reason }))(executionScheduler.inspect(plan, Array.isArray(plans) ? plans : delegatedPlans())) : {}),
    });
    session.sourceRevision = verificationContentHash(plan, (({ status, ...report }) => report)(buildReport(plan, session)));
    const interventions = interventionsOf(plan.conversationId);
    return interventions.length > 0 ? { ...session, interventions } : session;
  }

  function interventionsOf(conversationId) {
    const history = conversationStore.getPersistedConversationHistory?.(conversationId);
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    return messages
      .filter((message) => typeof message?.answerTo === 'string' && message.answerTo && message.id)
      .map((message) => ({ id: message.id }));
  }

  function buildReport(plan, session) {
    const history = conversationStore.getPersistedConversationHistory?.(plan.conversationId);
    return buildSessionReport(plan, session, history);
  }

  function freezeModels(input, workspaceId) {
    const source = {};
    const slots = {};
    let worker = null;
    let autoReason = null;
    for (const [role, slot] of ROLE_SLOTS) {
      const preference = role === 'session_worker' ? input.modelPreference : null;
      const request = {
        role,
        catalog,
        routing: routing || { tiers: {}, roles: {}, verifierPreferDifferentFamily: false },
        projectPolicy,
        requestPreference: preference?.modelProviderId
          ? { modelProviderId: preference.modelProviderId, reason: preference.reason }
          : null,
        workerModel: worker,
        taskRequiresVision: role === 'session_worker' && input.kind === 'ui',
        workspaceId,
      };
      const resolved = typeof resolveModel === 'function' ? resolveModel(request) : resolveRoleModel(request);
      if (!resolved?.ok) {
        if (role === 'visual_verifier' && input.kind !== 'ui') continue;
        return { ok: false, missing: resolved?.missing || '没有可用的模型' };
      }
      if (role === 'session_worker') worker = resolved.selection;
      slots[slot] = role === 'verifier'
        ? { ...resolved.selection, sameFamilyAsWorker: resolved.sameFamilyAsWorker === true }
        : resolved.selection;
      source[slot] = resolved.source;
      if (role === 'session_worker' && preference?.reason) autoReason = preference.reason;
    }
    return {
      ok: true,
      snapshot: {
        ...slots,
        source,
        ...(autoReason ? { autoReason } : {}),
        resolvedAt: now(),
      },
    };
  }

  function abandon(childId, reason) {
    try {
      conversationStore.appendMessage(childId, {
        id: randomUUID(),
        role: 'assistant',
        content: `任务未能建立：${reason}`,
      });
    } catch {
      // 原因写不进去时仍然归档，避免留下活跃的半成品会话。
    }
    try {
      conversationStore.archiveConversation(childId);
    } catch {
      // 归档失败留在调用方的错误返回里。
    }
  }

  async function spawnLocked(input, context) {
    const parentConversationId = text(context?.parentConversationId);
    const workspaceId = text(context?.workspaceId);
    let anchorMessageIds = stringList(input?.anchorMessageIds);
    let title = text(input?.title);
    let brief = text(input?.brief);
    let objectiveActionId = null;
    if (!parentConversationId || !workspaceId || anchorMessageIds.length === 0 || !title || !brief) {
      return { error: 'invalid_input', message: 'spawn input is incomplete' };
    }
    if (input?.objectiveId || context?.objectiveWakeEvents?.length&&!context?.currentInputAnchors?.length || context?.objectiveProposalAnswer) {
      if (typeof objectives?.prepareSpawn !== 'function') return {error:'objectives_unavailable'};
      const authorized = objectives.prepareSpawn(input, context);
      if (!authorized?.ok) return authorized;
      input = authorized.input || input;
      objectiveActionId = authorized.objectiveActionId || null;
      anchorMessageIds = stringList(input.anchorMessageIds); title = text(input.title); brief = text(input.brief);
    }
    const admitted = admitDelegationCriteria(input.successCriteria, {
      anchorMessageIds,
      manualAuthorities: typeof readManualCriterionAuthorities === 'function' ? readManualCriterionAuthorities({ workspaceId, anchorMessageIds }) : context?.manualCriterionAuthorities || [],
    });
    if (!admitted.ok) return admitted;
    const admittedCriteria = admitted.criteria;
    const supersedes = text(input?.supersedes);
    const key = objectiveActionId ? spawnIdentity(parentConversationId, {objectiveActionId}) : spawnIdentity(parentConversationId, {
      ...(context.coordinationOperationId ? { coordinationOperationId: context.coordinationOperationId } : {}),
      anchorMessageIds,
      title,
      brief,
      kind: input?.kind,
      readOnly: input?.readOnly,
      successCriteria: input?.successCriteria,
      dependsOn: input?.dependsOn,
      isolation: input?.isolation || 'auto',
      ...(input.objectiveId ? {objectiveId:input.objectiveId} : {}),
      ...(supersedes ? { supersedes } : {}),
    });
    const replay = findByKey(key, parentConversationId, input);
    if (replay) {
      if (input.objectiveId) objectives.linkSession(workspaceId,input.objectiveId,replay.delegationOrigin.sessionId);
      return {
        sessionId: replay.delegationOrigin.sessionId,
        status: replay.delegationOrigin.phase || project(replay).status,
        replayed: true,
      };
    }

    const dependencies = stringList(input?.dependsOn);
    if (dependencies.some(id => findBySession(id)?.delegationOrigin.workspaceId !== workspaceId)) {
      return { error: 'invalid_dependency', message: 'dependencies must be existing sessions in this project' };
    }
    if (input?.priority != null && !['high', 'normal', 'low'].includes(input.priority)) {
      return { error: 'invalid_input', message: 'priority must be high, normal, or low' };
    }
    if (input?.priority === 'high' && !hasCurrentUserUrgency({ conversationStore, ...context, anchorMessageIds })) return { error: 'urgency_required' };
    if (input?.isolation != null && !['auto', 'none', 'worktree'].includes(input.isolation)) {
      return { error: 'invalid_input', message: 'isolation must be auto, none, or worktree' };
    }
    const frozen = freezeModels(input || {}, workspaceId);
    if (!frozen.ok) return { error: 'model_unavailable', missing: frozen.missing };

    const history = conversationStore.getPersistedConversationHistory?.(parentConversationId);
    if (!history || !Array.isArray(history.messages)) {
      return { error: 'invalid_input', message: 'parent conversation is missing' };
    }
    const known = new Set(history.messages.map((message) => message?.id).filter(Boolean));
    if (anchorMessageIds.some((id) => !known.has(id))) {
      return { error: 'invalid_input', message: 'anchor message is missing' };
    }
    const previous = supersedes ? findBySession(supersedes) : null;
    if (supersedes && !previous) {
      return { error: 'session_not_found', message: 'superseded session was not found' };
    }
    if (previous) {
      const checked = continuity.replacement(supersedes, { workspaceId, parentConversationId });
      if (!checked.ok) return checked;
    }
    const replacingOpen = Boolean(previous && !TERMINAL.has(previous.status));
    const replacingHolder = Boolean(replacingOpen && occupiesRunningSlot(previous));

    let child = null;
    let planId = null;
    let spawnedSessionId = null;
    let releasedHolder = false;
    try {
      const sessionId = randomUUID();
      const inputId = text(context?.inputId) || randomUUID();
      const anchorMessageId = anchorMessageIds[0];
      const workspacePath = text(context?.workspacePath);
      const presetSnapshotId = text(context?.backgroundSnapshotId);
      // A delegation admits its explicit anchors, not an implicit fork of all
      // prior chat. Missing admitted material and explicit snapshots still ask.
      const attachments = attachmentsFromMessages(history.messages, anchorMessageIds);
      const carried = attachmentRefsFromMessages(history.messages, anchorMessageIds);
      const completeInlineAttachments = !presetSnapshotId
        && inlineAttachmentsCoverOmissions(history.messages, anchorMessageIds);
      child = conversationStore.createChildConversation({
        parentConversationId,
        role: 'work_session',
        anchorMessageId,
        title,
        workspacePath: workspacePath || null,
        workspaceId,
        mode: 'goal',
        modelProviderId: frozen.snapshot.worker.modelProviderId,
        delegation: { sessionId, anchorMessageId, inputId },
        runtimeState: {
          conversationId: parentConversationId,
          contentRevision: history.contentRevision,
          status: 'idle',
        },
        capturedAt: now(),
        ...(presetSnapshotId ? { backgroundSnapshotId: presetSnapshotId } : {}),
        ...(!presetSnapshotId ? { backgroundMessageIds: anchorMessageIds } : {}),
        ...(context?.confirmMissing === true || completeInlineAttachments ? { confirmMissing: true } : {}),
      });
      const messageId = randomUUID();
      const stored = conversationStore.appendMessage(child.id, {
        id: messageId,
        role: 'user',
        content: delegationMessage({
          brief,
          successCriteria: input.successCriteria,
          quotes: quotesFor(anchorMessageIds, history.messages),
          readOnly: input.readOnly === true,
        }),
        ...(carried.length > 0 ? { attachmentRefs: carried } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      if (!stored) throw new Error('delegation message was not stored');

      const snapshot = createSnapshot(workspaceId, memoryStore ? { store: memoryStore } : {});
      if (!snapshot.ok || typeof snapshot.snapshotId !== 'string') {
        const error = new Error(snapshot.reason || 'memory snapshot failed');
        error.code = 'memory_snapshot_failed';
        throw error;
      }
      const hold = resolvePlanApproval(approvalPolicy(workspaceId, context), input);
      const phase = hold
        ? 'awaiting_approval'
        : 'queued';
      const plan = goalPlanStore.createGoalContract({
        conversationId: child.id,
        title,
        goal: brief,
        successCriteria: admittedCriteria,
        status: phase === 'running' ? 'executing' : 'paused',
        ...(workspacePath ? { targetWorkspacePath: workspacePath, originWorkspacePath: workspacePath } : {}),
        createdBy: 'project_agent',
        activation: { sourceMessageId: messageId, acceptedBy: 'project_agent' },
        delegationOrigin: {
          anchorMessageId,
          inputId,
          ...(text(context?.workId) ? { workId: text(context.workId) } : {}),
          ...(context?.coordinationBinding ? { coordinationBinding: { ...structuredClone(context.coordinationBinding), sessionId } } : {}),
          surface: surfaceOf(context?.surface),
          memorySnapshotId: snapshot.snapshotId,
          modelSelection: frozen.snapshot,
          depth: Number.isInteger(context?.depth) && context.depth >= 0 ? context.depth : 1,
          workspaceId,
          sessionId,
          parentConversationId,
          readOnly: input.readOnly === true,
          priority: input.priority || 'normal',
          isolation: input.isolation || 'auto',
          ...(input.objectiveId ? {objectiveId:input.objectiveId} : {}),
          ...(objectiveActionId ? {objectiveActionId} : {}),
          phase,
          idempotencyKey: key,
          ...(text(context?.parentSessionId) ? { parentSessionId: text(context.parentSessionId) } : {}),
          ...(Array.isArray(input.dependsOn) && input.dependsOn.length > 0 ? { dependsOn: input.dependsOn } : {}),
        },
      });
      planId = plan?.planId || null;
      spawnedSessionId = sessionId;
      if (!plan?.delegationOrigin?.sessionId) throw new Error('delegationOrigin was not stored');
      if (context.coordinationBinding) workBudgetBinding(workspaceId)?.store.bindSession(context.coordinationBinding.workId,
        context.coordinationBinding.goalRevision, sessionId, { ...context.coordinationBinding, sessionId });
      if (!hold && isolationPlanner && canManageWorkspace(workspaceId) === true) await isolationPlanner.prepare(plan, delegatedPlans());
      if (hold) recordPlanApproval({ workspaceId, sessionId, plan, title, brief, successCriteria: input.successCriteria });
      if (replacingOpen) {
        const suspended = await continuity.suspend(supersedes, sessionId, { workspaceId, parentConversationId });
        if (!suspended.ok) throw new Error(suspended.error);
        releasedHolder = replacingHolder;
      }
      if (replacingHolder && !hold) {
        const current = goalPlanStore.getPlan(plan.planId) || plan;
        if (executionScheduler.inspect(current, delegatedPlans()).allowed) {
          goalPlanStore.revisePlan(plan.planId, { status: 'executing', delegationOrigin: { ...current.delegationOrigin, phase: 'running' } },
            { reason: 'replacement inherited available slot', changedBy: 'session-supervisor' });
          executionScheduler.reconcile(delegatedPlans());
          if (typeof goalRunner?.start !== 'function') throw new Error('goal runner unavailable');
          await goalRunner.start(plan.planId, { awaitIdle: false });
        }
      }
      await promote(plan.planId);
      const reportedPhase = goalPlanStore.getPlan(plan.planId)?.delegationOrigin.phase || phase;
      const queuedBehind = reportedPhase === 'queued'
        ? openPlans(workspaceId).filter((item) => item.delegationOrigin.phase === 'queued'
          || occupiesRunningSlot(item)).length - 1
        : 0;
      const queueReason = executionScheduler.inspect(goalPlanStore.getPlan(plan.planId) || plan, delegatedPlans()).reason;
      // All fallible spawn work must finish before a durable objective link is added.
      if (input.objectiveId && !objectives.linkSession(workspaceId,input.objectiveId,sessionId)?.ok) throw new Error('objective binding failed');
      emit({ kind: 'session_started', sessionId, planId: plan.planId, workspaceId });
      return {
        sessionId,
        status: reportedPhase,
        ...(queueReason ? { queueReason } : {}),
        ...(queuedBehind > 0 ? { queuedBehind } : {}),
      };
    } catch (error) {
      const reason = error?.code || error?.message || 'spawn failed';
      if (releasedHolder && planId && spawnedSessionId) {
        goalPlanStore.setPlanStatus(planId, 'failed');
        goalPlanStore.setRunnerState(planId, { status: 'failed', lastError: reason });
        if (isolationPlanner) await isolationPlanner.cleanup(goalPlanStore.getPlan(planId));
        await promote();
        if (input.objectiveId) objectives.linkSession(workspaceId,input.objectiveId,spawnedSessionId);
        return { sessionId: spawnedSessionId, status: 'failed', error: 'spawn_failed', message: reason };
      }
      if (planId) {
        const failedPlan = goalPlanStore.getPlan(planId);
        if (isolationPlanner && failedPlan?.deliveryBinding?.worktreePath) {
          const cleaned = await isolationPlanner.cleanup({ ...failedPlan, status: 'cancelled' });
          if (cleaned?.deliveryBinding?.worktreePath) {
            goalPlanStore.setPlanStatus(planId, 'failed');
            await isolationPlanner.cleanup(goalPlanStore.getPlan(planId));
            if (input.objectiveId) objectives.linkSession(workspaceId,input.objectiveId,spawnedSessionId);
            return { sessionId: spawnedSessionId, status: 'failed', error: 'spawn_failed', message: reason };
          }
        }
        try { goalPlanStore.deletePlan(planId); } catch { /* 计划已不在 */ }
      }
      if (child?.id) abandon(child.id, reason);
      return { error: 'spawn_failed', message: reason };
    }
  }

  async function promote(spawningPlanId = null) {
    if (isolationPlanner) {
      const virtual = delegatedPlans().filter(plan => canManageWorkspace(plan.delegationOrigin.workspaceId) === true && executionScheduler.isWorkspaceReady(plan.delegationOrigin.workspaceId));
      for (const plan of virtual) {
        if (plan.delegationOrigin.phase !== 'queued' || TERMINAL.has(plan.status) || plan.runner?.status === 'waiting_user') continue;
        const prepared = await isolationPlanner.prepare(plan, virtual);
        const index = virtual.findIndex(item => item.planId === plan.planId);
        virtual[index] = prepared.plan;
        if (prepared.ok && executionScheduler.inspect(prepared.plan, virtual).allowed) {
          virtual[index] = { ...prepared.plan, delegationOrigin: { ...prepared.plan.delegationOrigin, phase: 'running' } };
        }
      }
    }
    const plans = delegatedPlans().filter(plan => canManageWorkspace(plan.delegationOrigin.workspaceId) === true && executionScheduler.isWorkspaceReady(plan.delegationOrigin.workspaceId));
    const { start, blocked } = executionScheduler.select(plans);
    for (const plan of blocked) {
      goalPlanStore.revisePlan(plan.planId, {
        status: 'executing',
        delegationOrigin: { ...plan.delegationOrigin, phase: 'queued' },
      }, { reason: 'dependency requires a user decision', changedBy: 'session-supervisor' });
      goalPlanStore.setRunnerState(plan.planId, { status: 'waiting_user', phase: 'waiting_user',
        blockedReason: '前置任务未成功签收，请取消或重新安排依赖任务。' });
    }
    // Reserve every selected slot before any asynchronous Runner startup.
    if (typeof goalRunner?.start !== 'function') {
      if (start.length) throw new Error('goal runner unavailable');
      return;
    }
    for (const plan of start) {
      goalPlanStore.revisePlan(plan.planId, {
        status: 'executing', delegationOrigin: { ...plan.delegationOrigin, phase: 'running' },
      }, { reason: 'scheduler admitted session', changedBy: 'session-supervisor' });
    }
    executionScheduler.reconcile(delegatedPlans());
    let spawnError;
    let failedStart = false;
    for (const plan of start) {
      try { await goalRunner.start(plan.planId, { awaitIdle: false }); }
      catch (error) {
        failedStart = true;
        goalPlanStore.setPlanStatus(plan.planId, 'failed');
        goalPlanStore.setRunnerState(plan.planId, { status: 'failed', lastError: error?.message || 'runner start failed' });
        if (plan.planId === spawningPlanId) spawnError = error;
      }
    }
    if (failedStart) await promote();
    if (spawnError) throw spawnError;
  }


  function list(input = {}) {
    const limit = Number.isInteger(input?.limit) && input.limit > 0 ? Math.min(input.limit, 50) : 50;
    const workspaceId = text(input?.workspaceId);
    const status = text(input?.status);
    return delegatedPlans()
      .filter((plan) => !workspaceId || plan.delegationOrigin.workspaceId === workspaceId)
      .map(project)
      .filter((session) => !status || session.status === status)
      .slice(0, limit);
  }

  function get(input = {}) {
    const plan = findBySession(text(input?.sessionId));
    if (!plan) return null;
    const session = project(plan);
    if (input?.detail === 'report') return { ...session, report: buildReport(plan, session) };
    return session;
  }

  function policyFor(workspaceId, plan) {
    const fallback=plan?.delegationOrigin?.objectiveId?'confirm':'auto';
    if (typeof resolveAcceptancePolicy !== 'function') return fallback;
    try {
      return resolveAcceptancePolicy(workspaceId, plan) === 'confirm' ? 'confirm' : 'auto';
    } catch {
      return fallback;
    }
  }

  function hostFacts(plan) {
    if (typeof readSessionFacts !== 'function') return {};
    try {
      const facts = readSessionFacts(plan);
      return facts && typeof facts === 'object' ? facts : {};
    } catch {
      return {};
    }
  }

  function filesOf(plan) {
    const files = [];
    for (const item of Array.isArray(plan?.involvedFiles) ? plan.involvedFiles : []) {
      if (typeof item === 'string') files.push(item);
      else if (typeof item?.path === 'string') files.push(item.path);
    }
    return files;
  }

  function parentMessages(plan) {
    const history = conversationStore.getPersistedConversationHistory?.(plan?.delegationOrigin?.parentConversationId);
    return Array.isArray(history?.messages) ? history.messages : [];
  }

  function replyCites(message, sessionId) {
    if (!message || message.kind !== 'agent_reply' || !sessionId) return false;
    const sources = [
      ...(Array.isArray(message.sources) ? message.sources : []),
      ...(Array.isArray(message.meta?.sources) ? message.meta.sources : []),
    ];
    return sources.includes(sessionId);
  }

  function indexedRefs(plan) {
    if (typeof goalPlanStore.listEvidenceIndex !== 'function') return [];
    let records = [];
    try {
      records = goalPlanStore.listEvidenceIndex() || [];
    } catch {
      return [];
    }
    const conversationId = plan?.conversationId;
    return records
      .filter((record) => record?.planId === plan?.planId
        || (conversationId && record?.conversationId === conversationId))
      .map((record) => record.evidenceRef)
      .filter((ref) => typeof ref === 'string' && ref.trim());
  }

  function acceptanceFacts(plan) {
    const origin = plan.delegationOrigin || {};
    const messages = parentMessages(plan);
    const anchor = messages.find((message) => message?.id === origin.anchorMessageId);
    const extra = hostFacts(plan);
    const hostAuthority = extra.hostAuthority && typeof extra.hostAuthority === 'object' ? extra.hostAuthority : {};
    return {
      plan,
      sessionId: origin.sessionId,
      policy: policyFor(origin.workspaceId, plan),
      reported: messages.some((message) => replyCites(message, origin.sessionId)),
      readOnly: origin.readOnly === true,
      changedFiles: Array.isArray(extra.changedFiles) ? extra.changedFiles : filesOf(plan),
      irreversible: extra.irreversible === true,
      anchorText: typeof anchor?.content === 'string' ? anchor.content : '',
      manualCriteriaPending: extra.manualCriteriaPending === true,
      externalSideEffects: extra.externalSideEffects === true,
      outOfScopeWrite: extra.outOfScopeWrite === true,
      verificationBelowFloor: extra.verificationBelowFloor === true
        || !['passed', 'not_required'].includes(hostAuthority.independentVerifier),
      hostAuthority,
      evidenceIndex: indexedRefs(plan),
    };
  }

  function writeAcceptance(plan, acceptedBy, verdictRef) {
    return goalPlanStore.revisePlan(plan.planId, {
      resultAcceptance: {
        acceptedAt: now(),
        acceptedBy,
        verdictRef,
      },
      ...(acceptedBy === 'policy' && hostFacts(plan).autoHandoffOnPolicyAccept === true
        ? { delegationOrigin: { ...plan.delegationOrigin, handoffAuthorizedAt: now() } } : {}),
    }, { reason: acceptedBy === 'policy' ? 'policy acceptance' : 'user acceptance', changedBy: 'session-supervisor' });
  }

  async function settleLocked(sessionId) {
    const plan = findBySession(text(sessionId));
    if (!plan) return null;
    if (!sessionExecutionCurrent(plan)) return { ok: false, error: 'execution_revision_stale' };
    if (plan.resultAcceptance?.acceptedAt) {
      return { ok: true, alreadyAccepted: true, resultAcceptance: plan.resultAcceptance };
    }
    if (!resultCanBeAccepted(plan)) return { ok: false, error: 'session_not_completed' };
    const decision = decideSessionAcceptance(acceptanceFacts(plan));
    emit({
      kind: 'session_verified',
      sessionId: plan.delegationOrigin.sessionId,
      planId: plan.planId,
      workspaceId: plan.delegationOrigin.workspaceId,
      mode: decision.mode,
      verdictRef: decision.verdictRef,
    });
    if (decision.acceptedBy !== 'policy') return { ok: true, accepted: false, ...decision };
    try {
      const saved = writeAcceptance(plan, 'policy', decision.verdictRef);
      await handoff.afterAcceptance(saved);
      await promote();
      return {
        ok: true,
        accepted: true,
        ...decision,
        resultAcceptance: saved?.resultAcceptance ?? null,
      };
    } catch (error) {
      return { ok: false, error: error?.code || 'close_gate', ...decision };
    }
  }

  async function confirmLocked(sessionId) {
    const plan = findBySession(text(sessionId));
    if (!plan) return null;
    if (plan.resultAcceptance?.acceptedAt) {
      return { ok: true, alreadyAccepted: true, resultAcceptance: plan.resultAcceptance };
    }
    if (!resultCanBeAccepted(plan)) return { ok: false, error: 'session_not_completed' };
    const decision = decideSessionAcceptance(acceptanceFacts(plan), { userConfirm: true });
    if (decision.acceptedBy !== 'user') return { ok: false, error: 'not_confirmable', ...decision };
    try {
      const saved = writeAcceptance(plan, 'user', decision.verdictRef);
      await handoff.afterAcceptance(saved);
      await promote();
      return {
        ok: true,
        accepted: true,
        ...decision,
        resultAcceptance: saved?.resultAcceptance ?? null,
      };
    } catch (error) {
      return { ok: false, error: error?.code || 'close_gate', ...decision };
    }
  }

  async function messageLocked(input, context) {
    const plan = findBySession(text(input?.sessionId));
    const body = text(input?.text);
    if (!plan || !body) return null;
    const origin = plan.delegationOrigin;
    if (!context || context.role !== 'project_agent' || context.workspaceId !== origin.workspaceId
      || context.conversationId !== origin.parentConversationId || !canManageWorkspace(origin.workspaceId)) {
      return { error: 'agent_out_of_scope' };
    }
    const anchors = new Set(context.currentInputAnchors || []);
    const human = conversationStore.getPersistedConversationHistory(origin.parentConversationId)?.messages
      ?.find(row => anchors.has(row.id) && row.kind === 'user_input' && row.role === 'user'
        && typeof row.content === 'string' && row.content.trim() === body);
    if (!human) return { error: 'current_user_required', message: 'Use send_agent_message for autonomous work information.' };
    if (['paused', 'superseded'].includes(plan.delegationOrigin.phase)) return { error: 'session_not_running', message: 'Resume the paused session before sending instructions.' };
    if (input?.intent === 'amend' && TERMINAL.has(plan.status)) {
      return {
        error: 'session_not_running',
        message: 'amend only applies to a session that can still run',
      };
    }
    const amended = input?.intent === 'amend';
    const relay = amended ? `来自项目代理转达：用户说${body}` : body;
    const waiting = canConsumeRequestedUserInput(plan);
    if (waiting && plan.delegationOrigin.phase === 'queued') {
      return { error: 'dependency_requires_replan', message: '请取消或重新安排依赖任务。' };
    }
    if (waiting && plan.delegationOrigin.phase === 'awaiting_approval') {
      return { error: 'plan_approval_required', message: 'Use the local plan approval before resuming this task.' };
    }
    conversationStore.appendMessage(plan.conversationId, {
      id: randomUUID(),
      role: 'user',
      content: relay,
      ...(amended || waiting ? { kind: 'user_input', routeIntent: waiting ? 'answer' : 'correction' } : {}),
      ...(amended ? { relayFrom: 'project_agent' } : {}),
    });
    if (waiting) {
      if (typeof goalPlanStore.consumeRequestedUserInput === 'function') {
        goalPlanStore.consumeRequestedUserInput(plan.planId, {
          type: 'message_routed',
          summary: relay,
          payload: {
            source: 'project_agent',
            summaryCode: 'msg_follow_up',
            intent: 'follow_up',
            messageText: relay,
            ...(amended ? { relayFrom: 'project_agent' } : {}),
          },
        });
      }
      if (typeof goalRunner?.resume === 'function') await goalRunner.resume(plan.planId);
      const fresh = goalPlanStore.getPlan(plan.planId) || plan;
      return { ...project(fresh), delivered: true, delivery: 'answer', ...(amended ? { relayFrom: 'project_agent' } : {}) };
    }
    if (!amended) return project(goalPlanStore.getPlan(plan.planId) || plan);
    if (typeof goalPlanStore.appendRunEvent === 'function') {
      goalPlanStore.appendRunEvent(plan.planId, {
        type: 'user_correction',
        summary: relay,
        payload: {
          source: 'project_agent',
          summaryCode: 'msg_correction',
          intent: 'correction',
          messageText: relay,
          relayFrom: 'project_agent',
          effect: 'next_turn',
        },
      });
    }
    const fresh = goalPlanStore.getPlan(plan.planId) || plan;
    return { ...project(fresh), delivered: true, delivery: 'next_turn', relayFrom: 'project_agent' };
  }

  function recordPlanApproval({ workspaceId, sessionId, plan, title, brief, successCriteria }) {
    if (!approvalStore || typeof approvalStore.append !== 'function') return null;
    const criteria = Array.isArray(successCriteria) ? successCriteria.map(item => typeof item === 'string' ? item : item?.description).filter(Boolean) : [];
    return approvalStore.append({
      approvalId: `plan:${sessionId}`,
      workspaceId,
      sessionId,
      planId: plan.planId,
      conversationId: plan.conversationId,
      capabilityId: 'goal.plan',
      kind: 'plan_approval',
      taskName: title,
      summary: [title, brief, ...criteria].filter(Boolean).join('；'),
      riskLevel: 'plan',
      argsDigest: digestApprovalArgs({ title, brief, successCriteria: criteria }),
      state: 'open',
      createdAt: now(),
    });
  }

  function deliverAnswerLocked(input = {}) {
    const plan = findBySession(text(input.sessionId));
    const body = text(input.text);
    const answerTo = text(input.answerTo);
    const workspaceId = text(input.workspaceId);
    if (!plan || !body || !answerTo || !workspaceId) return { ok: false, error: 'workspace_mismatch' };
    if (plan.delegationOrigin?.workspaceId !== workspaceId) return { ok: false, error: 'workspace_mismatch' };
    const id = randomUUID();
    conversationStore.appendMessage(plan.conversationId, {
      id,
      role: 'user',
      content: body,
      answerTo,
      kind: 'user_input',
    });
    return { ok: true, userIntervened: true, messageId: id, session: project(plan) };
  }

  async function resumeFromApprovalLocked(approval = {}) {
    const sessionId = text(approval.sessionId);
    const plan = sessionId ? findBySession(sessionId) : null;
    const planId = text(approval.planId) || plan?.planId;
    if (!planId) return { ok: false, reason: 'missing_plan' };
    const current = goalPlanStore.getPlan(planId) || plan;
    if (!current) return { ok: false, reason: 'missing_plan' };
    if (['paused', 'superseded'].includes(current.delegationOrigin?.phase)) return { ok: false, reason: 'session_not_paused_by_approval', planId };
    if (current.delegationOrigin?.phase === 'awaiting_approval') {
      const decision = readLocalPlanApproval(current, approvalStore);
      if (!decision) return { ok: false, reason: 'plan_approval_required', planId };
      goalPlanStore.revisePlan(planId, {
        approval: decision, status: 'paused', delegationOrigin: { ...current.delegationOrigin, phase: 'queued' },
      }, { reason: 'plan approved', changedBy: 'session-supervisor' });
      await promote();
      const started = goalPlanStore.getPlan(planId)?.delegationOrigin.phase === 'running';
      return { ok: true, planId, ...(started ? { started: true } : { queued: true }) };
    }
    if (current.delegationOrigin?.phase === 'queued') {
      return { ok: false, reason: 'scheduler_not_admitted', planId };
    }
    if (typeof goalRunner?.resume !== 'function') return { ok: false, reason: 'runner_unavailable', planId };
    const resumed = await goalRunner.resume(planId);
    return { ok: Boolean(resumed), planId, resumed };
  }

  // 完成、失败、取消，以及重试已经用尽的失败，才让出名额。
  // failPlanRun 会带上 interruption，计划状态因此经常落成 interrupted 而不是 failed。
  // 可恢复、预算还没用完的中断仍占着名额。
  async function releaseSlotLocked(input = {}) {
    const planId = text(typeof input === 'string' ? input : input?.planId);
    if (!planId) return { ok: false, reason: 'missing_plan' };
    const plan = goalPlanStore.getPlan(planId);
    const origin = plan?.delegationOrigin;
    if (!origin?.sessionId || !origin.workspaceId) return { ok: false, reason: 'not_delegated' };
    if (occupiesRunningSlot(plan)) return { ok: false, reason: 'still_running' };
    if (origin.phase !== 'running' || !settled(plan)) return { ok: false, reason: 'not_slot_holder' };
    if (isolationPlanner) await isolationPlanner.cleanup(plan);
    await promote();
    return { ok: true, planId };
  }

  function releaseSlot(input) {
    const job = () => releaseSlotLocked(input || {});
    if (depth > 0) {
      return new Promise((resolve, reject) => {
        setImmediate(() => {
          exclusive(job).then(resolve, reject);
        });
      });
    }
    return exclusive(job);
  }

  if (typeof goalRunner?.setOnPlanTerminal === 'function') {
    goalRunner.setOnPlanTerminal((event) => {
      void releaseSlot({ planId: event?.planId }).catch(() => {});
    });
  }

  async function reconcilePersistedQueues() {
    for (const plan of delegatedPlans()) {
      if (canManageWorkspace(plan.delegationOrigin.workspaceId) !== true || !executionScheduler.isWorkspaceReady(plan.delegationOrigin.workspaceId)) continue;
      if (plan.delegationOrigin.phase === 'awaiting_approval' && readLocalPlanApproval(plan, approvalStore)) {
        await resumeFromApprovalLocked({ sessionId: plan.delegationOrigin.sessionId, planId: plan.planId });
      }
      if (isolationPlanner && !plan.delegationOrigin.cancellation && (TERMINAL.has(plan.status)
        || plan.status === 'interrupted' && plan.runner?.status === 'failed')) await isolationPlanner.cleanup(plan);
      if (plan.status === 'completed' && plan.resultAcceptance?.acceptedAt && plan.delegationOrigin.handoffAuthorizedAt
        && plan.deliveryHandoff?.status !== 'delivered' && plan.deliveryHandoff?.status !== 'stopped'
        && typeof goalRunner?.handoffDelegatedPlan === 'function') await handoff.afterAcceptance(plan);
      if (plan.status === 'completed' && !plan.resultAcceptance?.acceptedAt) await settleLocked(plan.delegationOrigin.sessionId);
    }
    await promote();
  }

  async function reconcileExpired() {
    for (const plan of delegatedPlans().filter(continuity.expired)) {
      if (canManageWorkspace(plan.delegationOrigin.workspaceId)) await cancellation.cancel({ sessionId: plan.delegationOrigin.sessionId,
        reason: 'supersession_expired', promote: false });
    }
  }
  const reconciled = deferRecovery ? Promise.resolve() : reconcileExpired().then(() => exclusive(() => reconcilePersistedQueues()));

  return {
    executionScheduler,
    coordinateWork: (input, context) => coordination.coordinate(input, context),
    coordinationFacts: (workspaceId, conversationId) => coordination.facts(workspaceId, conversationId),
    recoverCoordination: workspaceId => coordination.recover(workspaceId),
    sendAgentMessage: (input, context) => exclusive(() => communication.send(input, context)),
    recoverAgentMessages: () => exclusive(() => communication.recover()),
    auditLegacyCriteria(planId, criterionIds) { return legacyCriteria.audit(planId, criterionIds); },
    recoverLegacyCriteria(audit) {
      return exclusive(async () => {
        const revised = legacyCriteria.apply(audit);
        // Recheck the retained report under the revised authority; never launch a replacement task.
        if (typeof goalRunner?.start === 'function') await goalRunner.start(revised.planId, { awaitIdle: true });
        return goalPlanStore.getPlan(revised.planId);
      });
    },
    recoverQueue(workspaceId) {
      return exclusive(() => {
        if (!canManageWorkspace(workspaceId)) throw new Error('lease_unavailable');
        communication.recover();
        return executionScheduler.reconcile(delegatedPlans(), { workspaceId });
      });
    },
    resumeRecovered(workspaceId) {
      return cancellation.recover(delegatedPlans().filter(plan => plan.delegationOrigin.workspaceId === workspaceId)).then(() => coordination.recover(workspaceId)).then(() => exclusive(async () => {
        if (!executionScheduler.isWorkspaceReady(workspaceId) || !canManageWorkspace(workspaceId)) return;
        for (const plan of delegatedPlans().filter(plan => plan.delegationOrigin.workspaceId === workspaceId)) {
          if (isHostHandoffPause(plan)) {
            const { pausedFromPhase, pausedRunnerIntent, ...origin } = plan.delegationOrigin;
            goalPlanStore.revisePlan(plan.planId, {delegationOrigin:{...origin, phase:pausedFromPhase}},
              {reason:'host handoff recovered', changedBy:'session-supervisor'});
            if (typeof goalRunner?.resume === 'function') await goalRunner.resume(plan.planId,
              {awaitIdle:false, intent:pausedRunnerIntent || 'execute'});
            continue;
          }
          if (plan.delegationOrigin.phase !== 'running' || !['executing', 'interrupted'].includes(plan.status)
            || plan.runner?.status === 'waiting_user' || ['blocked', 'paused', 'budget_exhausted', 'failed', 'completed'].includes(plan.runner?.status)) continue;
          if (typeof goalRunner?.resume === 'function') await goalRunner.resume(plan.planId, { awaitIdle: false });
        }
        await reconcilePersistedQueues();
        // Startup queue repair runs before workspace readiness. Retry durable mail
        // only after the host has activated its execution admission gate.
        communication.recover();
      }));
    },
    async cancelWorkspace(workspaceId) {
      if (!canManageWorkspace(workspaceId)) return { ok: false, error: 'lease_unavailable' };
      for (const plan of delegatedPlans().filter(plan => plan.delegationOrigin.workspaceId === workspaceId)) {
        if (['completed', 'failed'].includes(plan.status) || plan.resultAcceptance?.acceptedAt) continue;
        const result = await cancellation.cancel({ sessionId: plan.delegationOrigin.sessionId, reason: 'bot_deleted', promote: false });
        if (result?.error) return { ok: false, ...result };
      }
      return { ok: true };
    },
    reconcile() { return reconcileExpired().then(() => exclusive(() => reconcilePersistedQueues())); },
    spawn(input, context) {
      return exclusive(() => spawnLocked(input, context || {}));
    },
    resume(input, context = {}) {
      return exclusive(async () => {
        const result = await continuity.resume(input, context);
        if (!result.ok) return result;
        if (!result.replayed) await promote();
        return { ...project(goalPlanStore.getPlan(result.plan.planId)), ...(result.replayed ? { replayed: true } : {}) };
      });
    },
    reprioritize(input, context = {}) {
      return exclusive(async () => {
        const result = continuity.reprioritize(input, context);
        if (!result.ok) return result;
        await promote();
        return project(goalPlanStore.getPlan(result.plan.planId));
      });
    },
    async controlWork(input, context = {}) {
      const checked = await exclusive(() => {
        const plan = findBySession(input.sessionId);
        const history = conversationStore.getPersistedConversationHistory?.(context.parentConversationId);
        if (!plan || plan.delegationOrigin.workspaceId !== context.workspaceId
          || plan.delegationOrigin.parentConversationId !== context.parentConversationId
          || !context.currentInputAnchors?.includes(input.anchorMessageId)
          || !history?.messages?.some(row => row.id === input.anchorMessageId && row.role === 'user')) return { error: 'current_user_required' };
        return { session: project(plan) };
      });
      if (checked.error) return checked;
      const controlled = await controlProjectWork({ session: checked.session, action: input.action, anchorMessageId: input.anchorMessageId, context,
        sessions: () => delegatedPlans().filter(row => row.delegationOrigin.workspaceId === context.workspaceId).map(project),
        pause: id => continuity.suspend(id, null, context), cancel: id => cancellation.cancel({ sessionId: id, reason: 'user cancelled work' }),
        resume: (sessionId, anchorMessageId) => continuity.resume({ sessionId, anchorMessageId }, context),
      });
      if (controlled.ok && input.action === 'resume') await exclusive(() => promote());
      return controlled;
    },
    list,
    /** One fresh plan read for a presentation query; same default bound/order as list(). */
    listByWorkspaceIds(workspaceIds) {
      const grouped = new Map(workspaceIds.map(id => [id, []]));
      if (!grouped.size) return grouped;
      const plans = delegatedPlans();
      for (const plan of plans) {
        const rows = grouped.get(plan.delegationOrigin.workspaceId);
        if (rows && rows.length < 50) rows.push(project(plan, plans));
      }
      return grouped;
    },
    /** Complete project facts for the host; model-facing list() remains bounded. */
    sessionsForProject(workspaceId) {
      const workspace = text(workspaceId);
      return workspace ? delegatedPlans().filter(plan => plan.delegationOrigin.workspaceId === workspace).map(project) : [];
    },
    get,
    deliveryFacts: handoff.facts,
    handleHandoffAnswer(input) { return exclusive(() => handoff.answer(input || {})); },
    cancel(input) {
      return cancellation.cancel(input || {});
    },
    requestCancel: input => cancellation.request(input || {}),
    recoverCancellations: workspaceId => cancellation.recover(delegatedPlans().filter(plan => plan.delegationOrigin.workspaceId === workspaceId)),
    message(input, context) {
      return exclusive(() => messageLocked(input || {}, context));
    },
    deliverAnswer(input) {
      return exclusive(() => deliverAnswerLocked(input || {}));
    },
    resumeFromApproval(approval) {
      return exclusive(() => resumeFromApprovalLocked(approval || {}));
    },
    settle(sessionId) {
      return exclusive(() => settleLocked(sessionId));
    },
    acceptance(sessionId) {
      const plan = findBySession(text(sessionId));
      return resultCanBeAccepted(plan) ? decideSessionAcceptance(acceptanceFacts(plan)) : null;
    },
    completionReview(sessionId) {
      const plan = findBySession(text(sessionId));
      return needsCompletionReview(plan) ? projectCompletionReview(plan, buildSessionReport(plan, project(plan),
        conversationStore.getPersistedConversationHistory(plan.conversationId))) : null;
    },
    confirmCompletion(input) {
      return exclusive(async () => {
        const plan = findBySession(text(input?.sessionId));
        if (!plan || !canManageWorkspace(plan.delegationOrigin.workspaceId)) return { ok: false, error: 'not_found' };
        try {
          const report = buildSessionReport(plan, project(plan), conversationStore.getPersistedConversationHistory(plan.conversationId));
          return await confirmCompletionReview({ plan, report, review: projectCompletionReview(plan, report),
          reviewToken: input.reviewToken, store: goalPlanStore, runner: goalRunner, now });
        } catch (error) { return { ok: false, error: error?.code || 'completion_confirmation_failed' }; }
      });
    },
    confirmResult(sessionId) {
      return exclusive(() => confirmLocked(sessionId));
    },
    evaluateWrite(sessionId, action) {
      const plan = findBySession(text(sessionId));
      return evaluateWorkSessionWrite(plan, action);
    },
    releaseSlot,
    reconciled,
  };
}

function delegationMessage({ brief, successCriteria, quotes, readOnly }) {
  const criteria = (Array.isArray(successCriteria) ? successCriteria : [])
    .map(item => typeof item === 'string' ? item : item?.description)
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => `- ${item.trim()}`)
    .join('\n');
  const anchors = quotes.filter(Boolean).map((quote) => `> ${quote}`).join('\n');
  const constraint = readOnly
    ? '约束：只读。不要写入、修改或执行会改变工作区的操作。'
    : '约束：可以在工作区边界内修改。';
  return ['委托说明', `目标：${brief}`, '完成标准：', criteria, '锚点原文：', anchors, constraint].join('\n');
}

function inlineAttachmentsCoverOmissions(messages, anchorMessageIds) {
  const rows = Array.isArray(messages) ? messages : [];
  const wanted = new Set(anchorMessageIds);
  const slice = rows.filter(row => wanted.has(row?.id));
  let sawAttachment = false;
  for (const row of slice) {
    if (!row || row.role === 'system' || row.role === 'developer') continue;
    if (row.role === 'tool') return false;
    if (row.tool_calls?.length) return false;
    if (Array.isArray(row.segments) && row.segments.some((segment) => segment?.type !== 'text' && segment?.type !== 'thinking')) {
      return false;
    }
    if (row.content != null && typeof row.content !== 'string') return false;
    const attachments = Array.isArray(row.attachments) ? row.attachments : [];
    if (attachments.length === 0) continue;
    const carried = normalizeInputAttachments(attachments);
    if (carried.length !== attachments.length || carried.some(item => (
      item.kind === 'image' ? !item.dataUrl : item.kind !== 'text' || typeof item.text !== 'string'
    ))) return false;
    sawAttachment = true;
  }
  return sawAttachment;
}

export function imageAttachmentsFromMessages(messages, anchorMessageIds) {
  return attachmentsFromMessages(messages, anchorMessageIds).filter(item => item.kind === 'image');
}

export function attachmentsFromMessages(messages, anchorMessageIds) {
  const wanted = new Set(Array.isArray(anchorMessageIds) ? anchorMessageIds : []);
  const images = [];
  const seen = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!wanted.has(message?.id)) continue;
    for (const image of normalizeInputAttachments(message?.attachments)) {
      const key = image.dataUrl || image.artifactRef || `${image.kind}:${image.id}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      images.push(image);
      if (images.length > 8) throw new TypeError('anchored messages contain more than 8 attachments');
    }
  }
  return images;
}

export function attachmentRefsFromMessages(messages, anchorMessageIds) {
  const wanted = new Set(Array.isArray(anchorMessageIds) ? anchorMessageIds : []);
  const refs = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!wanted.has(message?.id)) continue;
    const values = Array.isArray(message?.attachmentRefs) ? message.attachmentRefs : [];
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const ref = value.trim();
      if (!ref || ref.length > 500 || refs.includes(ref)) continue;
      refs.push(ref);
      if (refs.length >= 16) return refs;
    }
  }
  return refs;
}

function quotesFor(ids, messages) {
  const byId = new Map();
  for (const message of messages) {
    if (message?.id) byId.set(message.id, message);
  }
  return ids.map((id) => {
    const content = byId.get(id)?.content;
    return typeof content === 'string' ? content : '';
  });
}

function surfaceOf(value) {
  return ['desktop', 'quick_chat', 'tui', 'remote'].includes(value) ? value : 'desktop';
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter(Boolean);
}
