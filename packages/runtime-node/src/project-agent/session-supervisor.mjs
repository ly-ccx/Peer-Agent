import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';

import { projectWorkSession, resolveRoleModel } from '@peer-agent/protocol';

/**
 * 开任务：冻结模型 → 子会话 → 委托消息 → GoalPlan → 排队或启动。
 * 每个项目同时只有一个 phase=running 的任务，其余 queued。
 * 只读写入判定在 evaluateWorkSessionWrite。协议里的 writeScope 只有 workspace_and_boundaries，不能用来表示禁止写。
 * memorySnapshotId 在 B2-10 之前为 null。
 * 事件 kind 用 session_started / cancelled，收件箱映射留给 B2-05。
 * spawn(input, context)。调度 Provider 目前只把 input 传给端口，宿主接线不在本卡。
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

export function createSessionSupervisor({
  conversationStore,
  goalPlanStore,
  goalRunner = null,
  catalog = [],
  routing = null,
  projectPolicy = null,
  abortStream = null,
  emitEvent = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!conversationStore || !goalPlanStore) {
    throw new Error('createSessionSupervisor requires conversationStore and goalPlanStore');
  }

  let tail = Promise.resolve();
  function exclusive(task) {
    const run = tail.then(() => task(), () => task());
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

  function occupiesRunningSlot(plan) {
    return plan?.delegationOrigin?.phase === 'running' && !TERMINAL.has(plan.status);
  }

  function depsMet(dependsOn) {
    if (!Array.isArray(dependsOn) || dependsOn.length === 0) return true;
    const byId = new Map(delegatedPlans().map((plan) => [plan.delegationOrigin.sessionId, plan]));
    return dependsOn.every((id) => TERMINAL.has(byId.get(id)?.status));
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

  function project(plan) {
    const origin = plan.delegationOrigin;
    const conversation = conversationStore.getConversation?.(plan.conversationId);
    return projectWorkSession(snapshotOf(plan), {
      sessionId: origin.sessionId,
      workspaceId: origin.workspaceId || '',
      spawnedAt: conversation?.createdAt || plan.createdAt || '',
      origin,
    });
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
    const key = spawnKey(parentConversationId, {
      anchorMessageIds, title, brief, kind: input?.kind, readOnly: input?.readOnly, successCriteria: input?.successCriteria,
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

    let child = null;
    let planId = null;
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

      const phase = decidePhase(workspaceId, input.dependsOn);
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
          memorySnapshotId: null,
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
      if (!plan?.delegationOrigin?.sessionId) throw new Error('delegationOrigin was not stored');
      if (phase === 'running') {
        if (typeof goalRunner?.start !== 'function') throw new Error('goal runner unavailable');
        await goalRunner.start(plan.planId, { awaitIdle: true });
      }
      emit({ kind: 'session_started', sessionId, planId: plan.planId, workspaceId });
      const queuedBehind = phase === 'queued'
        ? openPlans(workspaceId).filter((item) => item.delegationOrigin.phase === 'queued'
          || occupiesRunningSlot(item)).length - 1
        : 0;
      return {
        sessionId,
        status: phase,
        ...(queuedBehind > 0 ? { queuedBehind } : {}),
      };
    } catch (error) {
      const reason = error?.code || error?.message || 'spawn failed';
      if (planId) {
        try { goalPlanStore.deletePlan(planId); } catch { /* 计划已不在 */ }
      }
      if (child?.id) abandon(child.id, reason);
      return { error: 'spawn_failed', message: reason };
    }
  }

  async function promote(workspaceId) {
    const next = openPlans(workspaceId)
      .filter((plan) => plan.delegationOrigin.phase === 'queued')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.planId).localeCompare(String(b.planId)))[0];
    if (!next || !depsMet(next.delegationOrigin.dependsOn)) return;
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
    const wasRunning = occupiesRunningSlot(plan);
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
    if (wasRunning) await promote(plan.delegationOrigin.workspaceId);
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

  function messageLocked(input) {
    const plan = findBySession(text(input?.sessionId));
    const body = text(input?.text);
    if (!plan || !body) return null;
    conversationStore.appendMessage(plan.conversationId, {
      id: randomUUID(),
      role: 'user',
      content: body,
    });
    return project(goalPlanStore.getPlan(plan.planId) || plan);
  }

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
    evaluateWrite(sessionId, action) {
      const plan = findBySession(text(sessionId));
      return evaluateWorkSessionWrite(plan, action);
    },
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
