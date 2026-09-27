import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';

import { projectWorkSession, resolveRoleModel } from '@peer-agent/protocol';

import { canConsumeRequestedUserInput } from '../goal-plan-store.mjs';
import { createSnapshot } from '../memory/memory-snapshot.mjs';
import { decideSessionAcceptance } from './acceptance.mjs';
import { digestApprovalArgs } from './approval-store.mjs';

/**
 * 开任务：冻结模型 → 子会话 → 委托消息 → GoalPlan → 排队或启动。
 * 每个项目同时只有一个 phase=running 的任务，其余 queued。
 * 占用名额的任务完成、失败，或任一任务被取消后，启动队列里最早且依赖已满足的下一个。
 * 重试用尽后落成 interrupted 的失败也让出名额。监督者建立时会再扫一遍已经落盘的队列。
 * 名额仍被占用时，这次唤醒直接返回。
 * 只读写入判定在 evaluateWorkSessionWrite。协议里的 writeScope 只有 workspace_and_boundaries，不能用来表示禁止写。
 * 开任务时把当时的 active 记忆 id 冻成 memorySnapshotId。
 * 事件 kind 用 session_started / cancelled，收件箱映射留给 B2-05。
 * spawn(input, context)。调度 Provider 目前只把 input 传给端口，宿主接线不在本卡。
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
const ROLE_SLOTS = [
  ['session_worker', 'worker'],
  ['explorer', 'explorer'],
  ['verifier', 'verifier'],
  ['visual_verifier', 'visualVerifier'],
];

export function evaluateWorkSessionWrite(plan, action = {}) {
  if (plan?.delegationOrigin?.readOnly !== true) return { allowed: true };
  const capabilityId = typeof action.capabilityId === 'string' ? action.capabilityId : '';
  const permissionKind = typeof action.permissionKind === 'string' ? action.permissionKind : '';
  const toolName = typeof action.toolName === 'string'
    ? action.toolName
    : (typeof action.name === 'string' ? action.name : '');
  const writing = WRITE_CAPABILITIES.has(capabilityId)
    || WRITE_KINDS.has(permissionKind)
    || WRITE_TOOLS.has(toolName);
  if (!writing) return { allowed: true };
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
  catalog = [],
  routing = null,
  projectPolicy = null,
  abortStream = null,
  emitEvent = null,
  resolveAcceptancePolicy = null,
  readSessionFacts = null,
  approvalStore = null,
  readPlanApproval = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!conversationStore || !goalPlanStore) {
    throw new Error('createSessionSupervisor requires conversationStore and goalPlanStore');
  }

  let tail = Promise.resolve();
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
    if (typeof emitEvent !== 'function') return;
    try {
      emitEvent({ ...event, at: event.at || now() });
    } catch {
      // 收件箱尚未接入。事件投递失败不回滚已经落盘的任务。
    }
  }

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

  function findByKey(key) {
    return delegatedPlans().find((plan) => plan.delegationOrigin.idempotencyKey === key) ?? null;
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

  function depsMet(dependsOn) {
    if (!Array.isArray(dependsOn) || dependsOn.length === 0) return true;
    const byId = new Map(delegatedPlans().map((plan) => [plan.delegationOrigin.sessionId, plan]));
    return dependsOn.every((id) => settled(byId.get(id)));
  }

  function decidePhase(workspaceId, dependsOn) {
    if (openPlans(workspaceId).some(occupiesRunningSlot)) return 'queued';
    if (!depsMet(dependsOn)) return 'queued';
    return 'running';
  }

  function snapshotOf(plan) {
    return {
      planId: plan.planId,
      status: plan.status,
      title: typeof plan.title === 'string' ? plan.title : '',
      runnerStatus: plan.runner?.status,
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

  function project(plan) {
    const origin = plan.delegationOrigin;
    const conversation = conversationStore.getConversation?.(plan.conversationId);
    const session = projectWorkSession(snapshotOf(plan), {
      sessionId: origin.sessionId,
      workspaceId: origin.workspaceId || '',
      spawnedAt: conversation?.createdAt || plan.createdAt || '',
      ...(typeof plan.conversationId === 'string' && plan.conversationId ? { conversationId: plan.conversationId } : {}),
      ...(origin.verifying === true ? { verifying: true, phase: 'verifying' } : {}),
      origin,
    });
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
    const findings = [];
    for (const criterion of Array.isArray(plan.successCriteria) ? plan.successCriteria : []) {
      const text = typeof criterion === 'string' ? criterion : criterion?.description;
      if (typeof text === 'string' && text.trim()) findings.push(text.trim());
    }
    const changedFiles = [];
    for (const item of Array.isArray(plan.involvedFiles) ? plan.involvedFiles : []) {
      if (typeof item === 'string' && item.trim()) changedFiles.push({ path: item.trim(), summary: '' });
      else if (typeof item?.path === 'string' && item.path.trim()) {
        changedFiles.push({ path: item.path.trim(), summary: typeof item.summary === 'string' ? item.summary : '' });
      }
    }
    const evidenceRefs = new Set();
    for (const ref of Array.isArray(plan.evidenceRefs) ? plan.evidenceRefs : []) {
      if (typeof ref === 'string' && ref.trim()) evidenceRefs.add(ref.trim());
    }
    for (const result of Array.isArray(plan.criterionResults) ? plan.criterionResults : []) {
      if (typeof result?.evidenceRef === 'string' && result.evidenceRef.trim()) evidenceRefs.add(result.evidenceRef.trim());
    }
    return {
      sessionId: session.sessionId,
      planId: plan.planId,
      status: session.status,
      summary: typeof plan.goal === 'string' ? plan.goal : '',
      keyFindings: findings,
      changedFiles,
      evidenceRefs: [...evidenceRefs],
    };
  }

  function freezeModels(input) {
    const source = {};
    const slots = {};
    let worker = null;
    let autoReason = null;
    for (const [role, slot] of ROLE_SLOTS) {
      const preference = role === 'session_worker' ? input.modelPreference : null;
      const resolved = resolveRoleModel({
        role,
        catalog,
        routing: routing || { tiers: {}, roles: {}, verifierPreferDifferentFamily: false },
        projectPolicy,
        requestPreference: preference?.modelProviderId
          ? { modelProviderId: preference.modelProviderId, reason: preference.reason }
          : null,
        workerModel: worker,
        taskRequiresVision: role === 'session_worker' && input.kind === 'ui',
      });
      if (!resolved?.ok) {
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
    const anchorMessageIds = stringList(input?.anchorMessageIds);
    const title = text(input?.title);
    const brief = text(input?.brief);
    if (!parentConversationId || !workspaceId || anchorMessageIds.length === 0 || !title || !brief) {
      return { error: 'invalid_input', message: 'spawn input is incomplete' };
    }
    const supersedes = text(input?.supersedes);
    const key = spawnKey(parentConversationId, {
      anchorMessageIds,
      title,
      brief,
      kind: input?.kind,
      readOnly: input?.readOnly,
      successCriteria: input?.successCriteria,
      ...(supersedes ? { supersedes } : {}),
    });
    const replay = findByKey(key);
    if (replay) {
      return {
        sessionId: replay.delegationOrigin.sessionId,
        status: replay.delegationOrigin.phase || project(replay).status,
        replayed: true,
      };
    }

    const frozen = freezeModels(input || {});
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
      });
      if (!stored) throw new Error('delegation message was not stored');

      const snapshot = createSnapshot(workspaceId);
      if (!snapshot.ok || typeof snapshot.snapshotId !== 'string') {
        const error = new Error(snapshot.reason || 'memory snapshot failed');
        error.code = 'memory_snapshot_failed';
        throw error;
      }
      const hold = resolvePlanApproval(approvalPolicy(workspaceId, context), input);
      const phase = hold
        ? 'awaiting_approval'
        : (replacingHolder ? 'queued' : decidePhase(workspaceId, input.dependsOn));
      const plan = goalPlanStore.createGoalContract({
        conversationId: child.id,
        title,
        goal: brief,
        successCriteria: Array.isArray(input.successCriteria) ? input.successCriteria : [],
        status: phase === 'running' ? 'executing' : 'paused',
        ...(workspacePath ? { targetWorkspacePath: workspacePath, originWorkspacePath: workspacePath } : {}),
        createdBy: 'project_agent',
        activation: { sourceMessageId: messageId, acceptedBy: 'project_agent' },
        delegationOrigin: {
          anchorMessageId,
          inputId,
          surface: surfaceOf(context?.surface),
          memorySnapshotId: snapshot.snapshotId,
          modelSelection: frozen.snapshot,
          depth: Number.isInteger(context?.depth) && context.depth >= 0 ? context.depth : 1,
          workspaceId,
          sessionId,
          parentConversationId,
          readOnly: input.readOnly === true,
          phase,
          idempotencyKey: key,
          ...(text(context?.parentSessionId) ? { parentSessionId: text(context.parentSessionId) } : {}),
          ...(Array.isArray(input.dependsOn) && input.dependsOn.length > 0 ? { dependsOn: input.dependsOn } : {}),
        },
      });
      planId = plan?.planId || null;
      spawnedSessionId = sessionId;
      if (!plan?.delegationOrigin?.sessionId) throw new Error('delegationOrigin was not stored');
      if (hold) recordPlanApproval({ workspaceId, sessionId, plan, title, brief, successCriteria: input.successCriteria });
      if (phase === 'running') {
        if (typeof goalRunner?.start !== 'function') throw new Error('goal runner unavailable');
        await goalRunner.start(plan.planId, { awaitIdle: true });
      }
      let reportedPhase = phase;
      if (replacingOpen) {
        const cancelled = await cancelLocked({
          sessionId: supersedes,
          reason: 'superseded by a new session',
          promote: false,
        });
        if (!cancelled) throw new Error('superseded session was not found');
        if (replacingHolder) {
          releasedHolder = true;
          const current = goalPlanStore.getPlan(plan.planId) || plan;
          goalPlanStore.revisePlan(plan.planId, {
            status: 'executing',
            delegationOrigin: { ...current.delegationOrigin, phase: 'running' },
          }, { reason: 'replacement took the running slot', changedBy: 'session-supervisor' });
          if (typeof goalRunner?.start !== 'function') throw new Error('goal runner unavailable');
          await goalRunner.start(plan.planId, { awaitIdle: true });
          reportedPhase = 'running';
        }
      }
      emit({ kind: 'session_started', sessionId, planId: plan.planId, workspaceId });
      const queuedBehind = reportedPhase === 'queued'
        ? openPlans(workspaceId).filter((item) => item.delegationOrigin.phase === 'queued'
          || occupiesRunningSlot(item)).length - 1
        : 0;
      return {
        sessionId,
        status: hold && !replacingHolder ? 'awaiting_approval' : reportedPhase,
        ...(queuedBehind > 0 ? { queuedBehind } : {}),
      };
    } catch (error) {
      const reason = error?.code || error?.message || 'spawn failed';
      if (releasedHolder && planId && spawnedSessionId) {
        return { sessionId: spawnedSessionId, status: 'running', error: 'spawn_failed', message: reason };
      }
      if (planId) {
        try { goalPlanStore.deletePlan(planId); } catch { /* 计划已不在 */ }
      }
      if (child?.id) abandon(child.id, reason);
      return { error: 'spawn_failed', message: reason };
    }
  }

  async function promote(workspaceId) {
    const open = openPlans(workspaceId);
    if (open.some(occupiesRunningSlot)) return;
    const next = open
      .filter((plan) => plan.delegationOrigin.phase === 'queued' && depsMet(plan.delegationOrigin.dependsOn))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.planId).localeCompare(String(b.planId)))[0];
    if (!next) return;
    if (typeof goalRunner?.start !== 'function') return;
    goalPlanStore.revisePlan(next.planId, {
      status: 'executing',
      delegationOrigin: { ...next.delegationOrigin, phase: 'running' },
    }, { reason: 'session queue promoted', changedBy: 'session-supervisor' });
    await goalRunner.start(next.planId, { awaitIdle: true });
  }

  async function cancelLocked(input) {
    const plan = findBySession(text(input?.sessionId));
    if (!plan) return null;
    const reason = text(input?.reason) || 'cancelled';
    if (typeof goalRunner?.pause === 'function') goalRunner.pause(plan.planId, reason);
    if (typeof abortStream === 'function') {
      await abortStream({
        sessionId: plan.delegationOrigin.sessionId,
        planId: plan.planId,
        conversationId: plan.conversationId,
        reason,
      });
    }
    goalPlanStore.setPlanStatus(plan.planId, 'cancelled');
    emit({
      kind: 'cancelled',
      sessionId: plan.delegationOrigin.sessionId,
      planId: plan.planId,
      workspaceId: plan.delegationOrigin.workspaceId,
      reason,
    });
    if (input?.promote !== false) await promote(plan.delegationOrigin.workspaceId);
    const next = goalPlanStore.getPlan(plan.planId);
    return next ? project(next) : null;
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

  function policyFor(workspaceId) {
    if (typeof resolveAcceptancePolicy !== 'function') return 'auto';
    try {
      return resolveAcceptancePolicy(workspaceId) === 'confirm' ? 'confirm' : 'auto';
    } catch {
      return 'auto';
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
      policy: policyFor(origin.workspaceId),
      reported: messages.some((message) => replyCites(message, origin.sessionId)),
      readOnly: origin.readOnly === true,
      changedFiles: Array.isArray(extra.changedFiles) ? extra.changedFiles : filesOf(plan),
      irreversible: extra.irreversible === true,
      anchorText: typeof anchor?.content === 'string' ? anchor.content : '',
      manualCriteriaPending: extra.manualCriteriaPending === true,
      externalSideEffects: extra.externalSideEffects === true,
      outOfScopeWrite: extra.outOfScopeWrite === true,
      verificationBelowFloor: extra.verificationBelowFloor === true,
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
    }, { reason: acceptedBy === 'policy' ? 'policy acceptance' : 'user acceptance', changedBy: 'session-supervisor' });
  }

  function settleLocked(sessionId) {
    const plan = findBySession(text(sessionId));
    if (!plan) return null;
    if (plan.resultAcceptance?.acceptedAt) {
      return { ok: true, alreadyAccepted: true, resultAcceptance: plan.resultAcceptance };
    }
    if (plan.status !== 'completed') return { ok: false, error: 'session_not_completed' };
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

  function confirmLocked(sessionId) {
    const plan = findBySession(text(sessionId));
    if (!plan) return null;
    if (plan.resultAcceptance?.acceptedAt) {
      return { ok: true, alreadyAccepted: true, resultAcceptance: plan.resultAcceptance };
    }
    if (plan.status !== 'completed') return { ok: false, error: 'session_not_completed' };
    const decision = decideSessionAcceptance(acceptanceFacts(plan), { userConfirm: true });
    if (decision.acceptedBy !== 'user') return { ok: false, error: 'not_confirmable', ...decision };
    try {
      const saved = writeAcceptance(plan, 'user', decision.verdictRef);
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

  async function messageLocked(input) {
    const plan = findBySession(text(input?.sessionId));
    const body = text(input?.text);
    if (!plan || !body) return null;
    if (input?.intent === 'amend' && TERMINAL.has(plan.status)) {
      return {
        error: 'session_not_running',
        message: 'amend only applies to a session that can still run',
      };
    }
    if (input?.intent !== 'amend') {
      conversationStore.appendMessage(plan.conversationId, {
        id: randomUUID(),
        role: 'user',
        content: body,
      });
      return project(goalPlanStore.getPlan(plan.planId) || plan);
    }
    const relay = `来自项目代理转达：用户说${body}`;
    const waiting = canConsumeRequestedUserInput(plan);
    conversationStore.appendMessage(plan.conversationId, {
      id: randomUUID(),
      role: 'user',
      kind: 'user_input',
      content: relay,
      relayFrom: 'project_agent',
      routeIntent: waiting ? 'answer' : 'correction',
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
            relayFrom: 'project_agent',
          },
        });
      }
      if (typeof goalRunner?.resume === 'function') await goalRunner.resume(plan.planId);
      const fresh = goalPlanStore.getPlan(plan.planId) || plan;
      return { ...project(fresh), delivered: true, delivery: 'answer', relayFrom: 'project_agent' };
    }
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
    const criteria = Array.isArray(successCriteria) ? successCriteria.filter((item) => typeof item === 'string') : [];
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
    if (current.delegationOrigin?.phase === 'awaiting_approval') {
      const phase = decidePhase(current.delegationOrigin.workspaceId, current.delegationOrigin.dependsOn);
      goalPlanStore.revisePlan(planId, {
        status: phase === 'running' ? 'executing' : 'paused',
        delegationOrigin: { ...current.delegationOrigin, phase },
      }, { reason: 'plan approved', changedBy: 'session-supervisor' });
      if (phase !== 'running') return { ok: true, planId, queued: true };
      if (typeof goalRunner?.start !== 'function') return { ok: false, reason: 'runner_unavailable', planId };
      await goalRunner.start(planId, { awaitIdle: true });
      return { ok: true, planId, started: true };
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
    await promote(origin.workspaceId);
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
    const workspaces = new Set();
    for (const plan of delegatedPlans()) {
      const workspaceId = plan.delegationOrigin?.workspaceId;
      if (workspaceId) workspaces.add(workspaceId);
    }
    for (const workspaceId of workspaces) await promote(workspaceId);
  }

  const reconciled = exclusive(() => reconcilePersistedQueues());

  return {
    spawn(input, context) {
      return exclusive(() => spawnLocked(input, context || {}));
    },
    list,
    get,
    cancel(input) {
      return exclusive(() => cancelLocked(input || {}));
    },
    message(input) {
      return exclusive(() => messageLocked(input || {}));
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
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => `- ${item.trim()}`)
    .join('\n');
  const anchors = quotes.filter(Boolean).map((quote) => `> ${quote}`).join('\n');
  const constraint = readOnly
    ? '约束：只读。不要写入、修改或执行会改变工作区的操作。'
    : '约束：可以在工作区边界内修改。';
  return ['委托说明', `目标：${brief}`, '完成标准：', criteria, '锚点原文：', anchors, constraint].join('\n');
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

function spawnKey(parentConversationId, input) {
  return createHash('sha256').update(JSON.stringify({ parentConversationId, ...input })).digest('hex');
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
