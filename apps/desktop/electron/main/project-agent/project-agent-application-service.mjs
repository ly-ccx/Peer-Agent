import { createAttentionExpiry } from './attention-expiry.mjs';
import { createBotAccessPolicyService } from './bot-access-policy-service.mjs';
import { createBotModelSelectionUpdater } from './bot-model-selection.mjs';
/**
 * 项目代理应用服务。渲染层的数据和动作都从这里过。
 * 开关关闭时直接拒绝，不调用会写盘的依赖。
 * 变化事件按 100ms 合并，带上这段时间里变化的 workspaceId。
 * 历史对话是旧会话的只读投影。继续时只给新任务拍继承背景，不改旧会话文件。
 */
import { randomUUID } from 'node:crypto';
import {
  BOT_LEVELS,
  cleanDisplayName,
  collectConversationSearchDocuments,
  createConversationSearchIndex,
  createImageReadAuthority,
  createProjectInputDraftStore,
  resolvePermissionPrincipal,
  projectClassicGoals,
  projectHistory,
} from '@peer-agent/runtime-node';
import { projectBotRecoveryStatus, projectModelRoutingMenuOption } from '@peer-agent/protocol';
import { settleActivePermissionRequest, sharedOneTimeApprovals } from '../chat-runtime/permission-gate.mjs';
import { projectBotModelViews } from './model-controls.mjs';
import { profilePolicyPatch } from './profile-policy.mjs';
import { evidenceRefAllowed, presentEvidence } from './evidence-presenter.mjs';

function defaultRememberGrant(input) {
  return sharedOneTimeApprovals.remember(input);
}

function defaultSettleLive(approval, grant) {
  const granted = grant?.decision === 'approved';
  return settleActivePermissionRequest(approval?.approvalId, {
    grantId: `card-${approval?.approvalId || 'approval'}`,
    toolCallId: approval?.approvalId,
    granted,
    duration: granted ? (grant.duration === 'task' ? 'task' : 'once') : 'denied',
    scope: approval?.capabilityId || null,
    decidedAt: new Date().toISOString(),
  }, { remember: grant?.remember === true, decidedBy: grant?.decision === 'expired' ? 'policy' : 'local_ui',
    ...(grant?.reason ? { reason: grant.reason } : grant?.decision === 'cancelled' ? { reason: 'permission_cancelled' } : {}) });
}

function sessionIdFromAnswer(answerTo) {
  const matched = /^card:question:([^:]+):/.exec(answerTo);
  if (!matched || matched[1] === 'reply') return '';
  return matched[1];
}

function isPlanApproval(record) {
  return record?.capabilityId === 'goal.plan'
    || (typeof record?.approvalId === 'string' && record.approvalId.startsWith('plan:'));
}

function disabled() {
  return { ok: false, code: 'PROJECT_AGENT_DISABLED' };
}

function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
}

export function createProjectAgentApplicationService({
  enabled = () => false,
  directory = null,
  lifecycle = null,
  profileStore = null,
  inputQueue = null,
  inputDrafts = createProjectInputDraftStore(),
  sessions = null,
  approvals = null,
  bindWorkspace = null,
  rememberWorkspace = null,
  createManaged = null,
  chooseAvatar = null,
  wake = null,
  onViewing = null,
  broadcast = () => {},
  schedule = defaultSchedule,
  now = () => new Date().toISOString(),
  debounceMs = 100,
  rememberGrant = defaultRememberGrant,
  settleLive = defaultSettleLive,
  agentOnline = () => true,
  readAgentStatus = () => undefined,
  readEvidenceBody = null,
  conversationStore = null,
  goalPlanStore = null,
  readSearchCorpus = null,
  corpusStamp = null,
  searchIndex = createConversationSearchIndex(),
  listModels = () => [],
  readModelRouting = () => undefined,
  retryTurn = null,
  readActivity = () => null,
  readRecovery = () => null,
  recoveryControl = null,
  stopResponseTurn = null,
  requestTakeover = null,
  diagnostics = null,
  accessAuthority = null,
} = {}) {
  const imageAuthority = createImageReadAuthority({ approvalStore: approvals });
  let corpusToken = null;
  const retrying = new Map();
  const expiry = createAttentionExpiry({ now, schedule, onExpired: workspaceId => {
    queueChanged(workspaceId); queueConversation(workspaceId);
  } });
  const pendingChanged = new Set();
  const pendingConversation = new Set();
  const accessPolicy = createBotAccessPolicyService({ authority: accessAuthority, enabled, changed: queueChanged, approvals });
  let changedTimer = null;
  let conversationTimer = null;

  function flush(bucket, timerSlot, channel) {
    const workspaceIds = [...bucket];
    bucket.clear();
    if (timerSlot === 'changed') changedTimer = null;
    else conversationTimer = null;
    if (workspaceIds.length === 0) return;
    broadcast(channel, { workspaceIds });
  }

  function queueChanged(workspaceId) {
    if (typeof workspaceId === 'string' && workspaceId) pendingChanged.add(workspaceId);
    if (changedTimer) return;
    changedTimer = schedule(() => flush(pendingChanged, 'changed', 'project-agent:changed'), debounceMs);
  }

  function queueConversation(workspaceId) {
    if (typeof workspaceId === 'string' && workspaceId) pendingConversation.add(workspaceId);
    if (conversationTimer) return;
    conversationTimer = schedule(
      () => flush(pendingConversation, 'conversation', 'project-agent:conversation-changed'),
      debounceMs,
    );
  }

  function open() {
    return enabled() === true;
  }

  function withAgentStatus(item) {
    if (!item) return item;
    expiry.observe(item.workspaceId, item.state?.attentionExpiresAt);
    const status = readAgentStatus(item.workspaceId);
    if (!['idle', 'thinking', 'waiting_provider', 'error'].includes(status)) return item;
    return { ...item, state: { ...item.state, agentStatus: status } };
  }

  function list(payload = {}) {
    if (!open()) return disabled();
    const items = typeof payload?.query === 'string' && payload.query.trim()
      ? directory.search(payload.query)
      : directory.list();
    if (typeof payload?.query !== 'string' || !payload.query.trim()) expiry.retain(items.map(item => item.workspaceId));
    const filtered = payload?.needsYouOnly === true
      ? items.filter((item) => item.state.needsYou > 0)
      : items;
    return { ok: true, items: filtered.map(withAgentStatus) };
  }

  function listAttention(payload = {}) {
    if (!open()) return disabled();
    if (payload.workspaceId !== undefined && (typeof payload.workspaceId !== 'string' || !directory.get(payload.workspaceId)?.ok)) return { ok: false, code: 'NOT_FOUND' };
    const items = directory.attention(payload.workspaceId);
    // Opening details can be the first read of a newly delivered decision.
    const byWorkspace = new Map();
    for (const item of items) if (item.expiresAt && (!byWorkspace.has(item.workspaceId) || Date.parse(item.expiresAt) < Date.parse(byWorkspace.get(item.workspaceId)))) byWorkspace.set(item.workspaceId, item.expiresAt);
    for (const [id, at] of byWorkspace) expiry.observe(id, at);
    return { ok: true, items };
  }

  function get(payload = {}) {
    if (!open()) return disabled();
    const result = directory.get(payload.workspaceId);
    if (!result?.ok || !result.item) return result;
    const providers = listModels().filter(model => model.enabled !== false);
    return { ...result, item: withAgentStatus(result.item),
      modelOptions: providers.map(projectModelRoutingMenuOption).filter(Boolean),
      modelViews: projectBotModelViews({ providers, routing: readModelRouting(), projectPolicy: result.item.profile?.modelPolicy }),
    };
  }

  function readAvatar(payload = {}) {
    if (!open()) return disabled();
    const result = profileStore?.readAvatar?.(payload.workspaceId);
    if (!result?.ok) return { ok: false, code: result?.code || 'INVALID_IMAGE' };
    return { ok: true, dataUrl: `data:${result.mime};base64,${result.bytes.toString('base64')}` };
  }

  async function create(payload = {}, sender = null) {
    if (!open()) return disabled();
    if (payload?.kind === 'bind') {
      if (typeof bindWorkspace !== 'function') return { ok: false, code: 'BIND_UNAVAILABLE' };
      const bound = await bindWorkspace(sender);
      if (!bound?.id) return { ok: false, code: 'CANCELLED' };
      const bot = lifecycle.ensureBot(bound.id, { managed: false });
      if (!bot?.ok) return bot;
      const familiarize = await lifecycle.startFamiliarize?.(bound.id) ?? null;
      queueChanged(bound.id);
      return { ok: true, workspaceId: bound.id, profile: bot.profile, familiarize };
    }
    if (payload?.kind === 'managed') {
      if (typeof createManaged !== 'function') return { ok: false, code: 'MANAGED_UNAVAILABLE' };
      const created = createManaged(payload.name);
      if (!created?.ok) return created;
      const workspaceId = created.workspace?.workspaceId;
      if (typeof rememberWorkspace === 'function') {
        rememberWorkspace({
          workspaceId,
          path: created.path,
          name: created.name,
        });
      }
      const bot = lifecycle.ensureBot(workspaceId, { managed: true });
      if (!bot?.ok) return bot;
      const familiarize = await lifecycle.startFamiliarize?.(workspaceId) ?? null;
      queueChanged(workspaceId);
      return { ok: true, workspaceId, path: created.path, profile: bot.profile, familiarize };
    }
    return { ok: false, code: 'INVALID_INPUT' };
  }

  async function updateProfile(payload = {}, sender = null) {
    if (!open()) return disabled();
    const workspaceId = payload?.workspaceId;
    const current = profileStore?.read?.(workspaceId);
    if (!current || current.status === 'archived') return { ok: false, code: 'NOT_FOUND' };
    const policy = profilePolicyPatch(payload, listModels());
    if (!policy.ok) return policy;
    if (typeof payload.displayName === 'string') {
      const displayName = cleanDisplayName(payload.displayName);
      if (!displayName) return { ok: false, code: 'INVALID_NAME' };
      const saved = profileStore.save({ ...current, displayName });
      if (!saved?.ok) return saved;
    }
    if (payload.regenerateAvatar === true) {
      const rotated = lifecycle.regenerateAvatar(workspaceId);
      if (!rotated?.ok) return rotated;
    }
    if (payload.avatarColor !== undefined) {
      const recolored = lifecycle.setAvatarColor(workspaceId, payload.avatarColor);
      if (!recolored?.ok) return recolored;
    }
    if (typeof payload.proactivity === 'string') {
      if (!BOT_LEVELS.includes(payload.proactivity)) return { ok: false, code: 'INVALID_PROACTIVITY' };
      const latest = profileStore.read(workspaceId) || current;
      const saved = profileStore.save({ ...latest, proactivity: payload.proactivity });
      if (!saved?.ok) return saved;
    }
    if (payload.chooseAvatar === true) {
      if (typeof chooseAvatar !== 'function') return { ok: false, code: 'AVATAR_UNAVAILABLE' };
      const sourcePath = await chooseAvatar(sender);
      if (!sourcePath) return { ok: false, code: 'CANCELLED' };
      const installed = lifecycle.uploadAvatar(workspaceId, sourcePath);
      if (!installed?.ok) return installed;
    }
    if (Object.keys(policy.patch).length) {
      const saved = profileStore.save({ ...profileStore.read(workspaceId), ...policy.patch });
      if (!saved?.ok) return saved;
    }
    queueChanged(workspaceId);
    return { ok: true, profile: profileStore.read(workspaceId) };
  }

  async function deleteBot(payload = {}) {
    if (!open()) return disabled();
    const result = await lifecycle.deleteBot(payload.workspaceId, {
      confirmManaged: payload.confirmManaged === true,
    });
    if (result?.ok || result?.archived) queueChanged(payload.workspaceId);
    return result;
  }

  function draftRequest(payload, operation) {
    if (!open()) return disabled();
    if (!['desktop', 'quick_chat', 'tui'].includes(payload?.surface) || !directory.get(payload?.workspaceId)?.ok) return { ok: false, code: 'NOT_FOUND' };
    return inputDrafts[operation](payload);
  }

  async function submitInput(payload = {}) {
    if (!open()) return disabled();
    try {
      const answerTo = typeof payload.answerTo === 'string' ? payload.answerTo.trim() : '';
      if (answerTo.startsWith('card:question:reply:') && typeof directory.questionState === 'function') {
        const existing = inputQueue.findSubmission?.(payload.workspaceId, payload.inputId);
        if (existing) return { ok: true, input: existing, delivery: 'queued' };
        const answered = inputQueue.findAnswer?.(payload.workspaceId, answerTo);
        if (answered || directory.questionState(payload.workspaceId, answerTo.slice('card:question:reply:'.length)) !== 'open') {
          queueChanged(payload.workspaceId); queueConversation(payload.workspaceId);
          return { ok: false, code: 'QUESTION_CLOSED' };
        }
      }
      const input = inputQueue.submitInput({
        workspaceId: payload.workspaceId,
        inputId: payload.inputId,
        surface: payload.surface || 'desktop',
        text: payload.text,
        anchorRefs: payload.anchorRefs,
        quoteRefs: payload.quoteRefs,
        attachmentRefs: payload.attachmentRefs,
        attachments: payload.attachments,
        resourceFeedback: payload.resourceFeedback,
        createdAt: payload.createdAt,
        ...(answerTo ? { answerTo } : {}),
      });
      const handoff = answerTo && typeof sessions?.handleHandoffAnswer === 'function'
        ? await sessions.handleHandoffAnswer({ sessionId: sessionIdFromAnswer(answerTo), workspaceId: payload.workspaceId,
          answerTo, text: input.text }) : null;
      if (typeof wake === 'function') {
        try { wake(payload.workspaceId); } catch { /* 唤醒失败不回滚已经入队的输入 */ }
      }
      queueConversation(payload.workspaceId);
      queueChanged(payload.workspaceId);
      if (handoff?.error) return { ok: false, code: 'HANDOFF_FAILED', input,
        message: '未能清理任务工作区，改动仍已保留，请重试。' };
      let delivery = 'queued';
      if (!handoff?.handled && answerTo && agentOnline(payload.workspaceId) !== true && typeof sessions?.deliverAnswer === 'function') {
        const sessionId = sessionIdFromAnswer(answerTo);
        if (sessionId) {
          try {
            const delivered = await Promise.resolve(sessions.deliverAnswer({
              sessionId,
              text: input.text,
              answerTo,
              workspaceId: payload.workspaceId,
            }));
            if (delivered?.error === 'workspace_mismatch') {
              return { ok: false, code: 'NOT_FOUND', input };
            }
            if (delivered?.userIntervened === true) delivery = 'user_intervened';
          } catch {
            delivery = 'queued';
          }
        }
      }
      return { ok: true, input, delivery };
    } catch (error) {
      return { ok: false, code: ['RESOURCE_FEEDBACK_RECIPIENT_CHANGED', 'INVALID_RESOURCE_FEEDBACK'].includes(error?.code) ? error.code : 'INVALID_INPUT', message: error?.message || 'invalid input' };
    }
  }

  function readConversation(payload = {}) {
    if (!open()) return disabled();
    const result = payload.processFor && typeof directory.readProcess === 'function' ? directory.readProcess(payload.workspaceId, payload)
      : payload.view === 'interactions' && typeof directory.readInteractions === 'function'
        ? directory.readInteractions(payload.workspaceId, payload) : directory.readConversation(payload.workspaceId, payload);
    const decorate = page => {
      page = { ...page, recoveryAttention: recoveryControl?.needsAttention?.(payload.workspaceId) === true };
      const status = readRecovery(payload.workspaceId);
      const recovery = status?.status === 'failed' ? projectBotRecoveryStatus(status.error, status.phase)
        : !page?.ok && page?.code?.startsWith('coordination_') ? projectBotRecoveryStatus(page.code) : null;
      if (!page?.ok) return { ...page, recovery };
      try { return { ...page, recovery, activity: readActivity(payload.workspaceId) }; }
      catch { return { ...page, recovery, activity: null }; }
    };
    return result && typeof result.then === 'function' ? result.then(decorate) : decorate(result);
  }

  function stopResponse(payload = {}) {
    if (!open()) return disabled();
    if (typeof payload.workspaceId !== 'string' || typeof payload.turnId !== 'string' || !payload.turnId || payload.turnId.length > 200) return { ok: false, code: 'INVALID_INPUT' };
    if (!directory.get(payload.workspaceId)?.ok) return { ok: false, code: 'NOT_FOUND' };
    return stopResponseTurn?.(payload) || { ok: false, code: 'HOST_OFFLINE' };
  }

  function listSessions(payload = {}) {
    if (!open()) return disabled();
    return { ok: true, sessions: sessions.list(payload) };
  }

  async function getSession(payload = {}) {
    if (!open()) return disabled();
    const session = await sessions.get(payload);
    if (!session) return { ok: false, code: 'NOT_FOUND' };
    return { ok: true, session };
  }

  async function cancelSession(payload = {}) {
    if (!open()) return disabled();
    const session = await sessions.cancel(payload);
    if (!session) return { ok: false, code: 'NOT_FOUND' };
    if (session.error) return { ok: false, code: session.error };
    queueChanged(payload.workspaceId || session.workspaceId);
    return { ok: true, session };
  }

  async function resumeSession(payload = {}) {
    if (!open()) return disabled();
    const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : '';
    const session = await sessions.get({ sessionId: payload.sessionId });
    const profile = profileStore?.read(workspaceId);
    if (!session || !profile || profile.status !== 'active' || session.workspaceId !== workspaceId || session.origin?.parentConversationId !== profile.agentConversationId) return { ok: false, code: 'OUT_OF_SCOPE' };
    if (agentOnline(workspaceId) !== true) return { ok: false, code: 'AGENT_OFFLINE' };
    if (typeof payload.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(payload.requestId)) return { ok: false, code: 'INVALID_INPUT' };
    const anchorMessageId = `resume:${session.sessionId}:${payload.requestId}`;
    if (session.origin?.lastResumeAnchorMessageId === anchorMessageId) return { ok: true, session };
    if (!['paused', 'superseded'].includes(session.status)) return { ok: false, code: 'NOT_PAUSED' };
    const history = conversationStore?.getPersistedConversationHistory(profile.agentConversationId);
    if (!history?.messages?.some(message => message.id === anchorMessageId)) {
      const stored = conversationStore?.appendMessage(profile.agentConversationId, {
        id: anchorMessageId, role: 'user', kind: 'user_input', content: `恢复任务「${session.title}」`,
      });
      if (!stored) return { ok: false, code: 'ANCHOR_STORE_FAILED' };
    }
    const result = await sessions.resume({ sessionId: session.sessionId, anchorMessageId },
      { workspaceId, parentConversationId: profile.agentConversationId });
    if (!result || result.error) return { ok: false, code: result?.error || 'RESUME_FAILED' };
    queueChanged(workspaceId);
    return { ok: true, session: result };
  }

  function listApprovals(payload = {}) {
    if (!open()) return disabled();
    return { ok: true, approvals: approvals.list(payload) };
  }

  async function decideApproval(payload = {}) {
    if (!open()) return disabled();
    const decision = payload.decision === 'approve'
      ? 'approved'
      : payload.decision === 'cancel' ? 'cancelled' : (payload.decision === 'reject' || payload.decision === 'deny' ? 'denied' : '');
    if (!decision) return { ok: false, code: 'INVALID_INPUT' };
    const listed = approvals.list({ workspaceId: payload.workspaceId });
    let current = listed.find((item) => item.approvalId === payload.approvalId);
    const expireDeadline = record => {
      const at = Date.parse(typeof now === 'function' ? now() : now);
      if (!record || !['open', 'stale'].includes(record.state) || !record.deadlineAt || Date.parse(record.deadlineAt) > (Number.isFinite(at) ? at : Date.now())) return record;
      // Claim through the live gate as well, so a delayed timer cannot leave the tool waiting.
      if (record.state === 'open') { try { settleLive?.(record, { decision: 'expired', reason: 'permission_timeout' }); } catch {} }
      const latest = approvals.list({ workspaceId: payload.workspaceId }).find(row => row.approvalId === record.approvalId);
      if (latest && !['open', 'stale'].includes(latest.state)) return latest;
      return approvals.append({ ...record, state: 'expired', decidedBy: 'policy', decisionReason: 'permission_timeout', decidedAt: typeof now === 'function' ? now() : now });
    };
    current = expireDeadline(current);
    if (!current) return { ok: false, code: 'NOT_FOUND' };
    if (!isPlanApproval(current) && ['open', 'stale'].includes(current.state) && accessAuthority) {
      const resolved = accessAuthority.resolve({ conversationId: current.conversationId, workspaceId: current.workspaceId,
        sessionId: current.sessionId, planId: current.planId });
      const stamp = resolved?.ok ? `bot:${resolved.policy.workspaceId}:${resolved.policy.conversationId}:${resolved.policy.revision}` : null;
      if (resolved && (!resolved.ok || (current.policyRevision ?? (resolved.policy.revision === 1 ? stamp : 'legacy')) !== stamp)) {
        try { settleLive?.(current, { decision: 'expired', reason: 'permission_policy_changed' }); } catch {}
        current = approvals.append({ ...current, state: 'expired', decidedBy: 'policy', decisionReason: 'permission_policy_changed', decidedAt: now() });
        queueChanged(payload.workspaceId);
        return { ok: true, approval: current };
      }
      if (stamp && !current.policyRevision) current = { ...current, policyRevision: stamp };
    }
    if (current.state === 'approved' || current.state === 'denied' || current.state === 'expired' || current.state === 'cancelled') {
      const waiting = decision === 'approved' && current.state === 'approved' && isPlanApproval(current) && current.sessionId
        && typeof sessions?.get === 'function' ? await sessions.get({ sessionId: current.sessionId }) : null;
      if (waiting?.origin?.phase === 'awaiting_approval' && typeof sessions?.resumeFromApproval === 'function') {
        const resumed = await sessions.resumeFromApproval(current);
        queueChanged(payload.workspaceId);
        return { ok: true, approval: current, resumed };
      }
      return { ok: true, approval: current };
    }
    const currentSession = current.sessionId && typeof sessions?.get === 'function'
      ? await sessions.get({ sessionId: current.sessionId }) : null;
    const refreshed = approvals.list({ workspaceId: payload.workspaceId }).find(row => row.approvalId === current.approvalId);
    if (refreshed && !['open', 'stale'].includes(refreshed.state)) return { ok: true, approval: refreshed };
    current = expireDeadline(refreshed ?? current);
    if (current && !['open', 'stale'].includes(current.state)) return { ok: true, approval: current };
    if (decision === 'approved' && currentSession && ['paused', 'superseded', 'cancelled'].includes(currentSession.status)) return { ok: false, code: 'SESSION_PAUSED' };
    const duration = decision !== 'approved'
      ? 'denied'
      : payload.duration === 'task'
        ? 'task'
        : 'once';
    const plan = isPlanApproval(current);
    const decisionRecord = { ...current, state: decision,
      decidedAt: typeof now === 'function' ? now() : now, decidedBy: 'local_ui',
      ...(decision === 'cancelled' ? { decisionReason: 'permission_cancelled' } : decision === 'denied' ? { decisionReason: 'local_user_denied' } : {}) };
    if (decision === 'approved' && duration === 'task' && current.state === 'stale' && current.capabilityId === 'local.image.read') {
      try {
        const principal = resolvePermissionPrincipal({ ...current, goalPlanStore });
        if (principal && current.policyRevision) principal.policyRevision = current.policyRevision;
        if (!imageAuthority.remember({ principal, scope: current.imageReadScope, record: decisionRecord })) {
          return { ok: false, code: 'IMAGE_AUTHORIZATION_UNAVAILABLE' };
        }
      } catch { return { ok: false, code: 'IMAGE_AUTHORIZATION_UNAVAILABLE' }; }
    }
    let saved = null;
    if (plan && decision === 'approved') {
      saved = approvals.append(decisionRecord);
      if (!saved) return { ok: false, code: 'NOT_FOUND' };
    }
    let resumed = null;
    if (decision === 'approved' && (plan || current.state === 'stale')) {
      if (!plan && current.state === 'stale' && typeof rememberGrant === 'function') {
        try {
          rememberGrant({
            capabilityId: current.capabilityId,
            argsDigest: current.argsDigest,
            sessionId: current.sessionId,
            workspaceId: current.workspaceId,
            policyRevision: current.policyRevision,
            at: Date.now(),
          });
        } catch {
          // 授权簿写失败时仍然记下决定，恢复路径还能再问一次。
        }
      }
      if (typeof sessions?.resumeFromApproval === 'function') {
        try {
          resumed = await sessions.resumeFromApproval(saved || current);
        } catch (error) {
          resumed = { ok: false, message: error?.message || 'resume failed' };
        }
      }
    } else if (plan && decision !== 'approved' && typeof sessions?.cancel === 'function') {
      try {
        resumed = await sessions.cancel({
          sessionId: current.sessionId,
          reason: 'plan_approval_denied',
        });
      } catch (error) {
        return { ok: false, code: 'CANCEL_FAILED', message: error?.message || 'cancel failed' };
      }
    } else if (current.state === 'open' && !plan) {
      // The live gate claims the request before signing any resource grant. A stale
      // button must never overwrite a timeout/cancel that happened during awaits.
      let settled = false;
      try { settled = settleLive?.(current, { decision, duration, remember: decision === 'approved' && duration === 'task' }) === true; } catch {}
      const latest = approvals.list({ workspaceId: payload.workspaceId }).find(row => row.approvalId === current.approvalId);
      if (latest && !['open', 'stale'].includes(latest.state)) {
        queueChanged(payload.workspaceId);
        return { ok: true, approval: latest };
      }
      if (!settled) {
        saved = approvals.append({ ...current, state: 'expired', decidedBy: 'policy', decisionReason: 'permission_unavailable', decidedAt: new Date().toISOString() });
        queueChanged(payload.workspaceId);
        return { ok: true, approval: saved };
      }
    }
    saved ||= approvals.append(decisionRecord);
    if (!saved) return { ok: false, code: 'NOT_FOUND' };
    queueChanged(payload.workspaceId);
    return { ok: true, approval: saved, ...(resumed ? { resumed } : {}) };
  }

  function markRead(payload = {}) {
    if (!open()) return disabled();
    if (payload?.viewing === false) {
      if (typeof onViewing === 'function') onViewing(null);
      return { ok: true, viewing: false };
    }
    const marked = directory.markRead(payload.workspaceId);
    if (marked?.ok) {
      if (marked.changed !== false) queueChanged(payload.workspaceId);
      if (typeof onViewing === 'function') onViewing(payload.workspaceId);
      const { changed, ...result } = marked;
      return result;
    }
    return marked;
  }

  function search(payload = {}) {
    if (!open()) return disabled();
    const snapshot = typeof directory?.query === 'function' ? directory.query(payload.query) : null;
    const items = snapshot?.items ?? (typeof directory?.search === 'function' ? directory.search(payload.query) : []);
    let hits = [];
    if (searchIndex && typeof readSearchCorpus === 'function') {
      try {
        const token = typeof corpusStamp === 'function' ? String(corpusStamp(snapshot?.catalog) ?? '') : null;
        if (token === null || token !== corpusToken) {
          searchIndex.sync(collectConversationSearchDocuments(readSearchCorpus(snapshot?.catalog) || {}));
          if (token !== null) corpusToken = token;
        }
        hits = searchIndex.search(typeof payload?.query === 'string' ? payload.query : '');
      } catch {
        hits = [];
      }
    }
    return { ok: true, items, hits };
  }

  function listHistory(payload = {}) {
    if (!open()) return disabled();
    if (!conversationStore || typeof conversationStore.listConversations !== 'function') {
      return { ok: false, code: 'CONVERSATION_REQUIRED' };
    }
    const unscoped = payload?.unscoped === true;
    let folder = typeof payload?.workspacePath === 'string' ? payload.workspacePath : '';
    if (!unscoped && !folder && payload?.workspaceId && typeof directory?.get === 'function') {
      const got = directory.get(payload.workspaceId);
      if (got?.ok && typeof got.path === 'string') folder = got.path;
    }
    if (!unscoped && !folder) return { ok: true, history: [], goals: [] };
    let conversations = [];
    try {
      conversations = conversationStore.listConversations() || [];
    } catch (error) {
      return { ok: false, code: 'CONVERSATION_REQUIRED', message: error?.message || 'list failed' };
    }
    const history = projectHistory(conversations, { workspacePath: unscoped ? null : folder });
    let goals = [];
    if (!unscoped && typeof goalPlanStore?.listPlans === 'function') {
      try {
        const plans = goalPlanStore.listPlans();
        goals = projectClassicGoals(Array.isArray(plans) ? plans : [], {
          workspacePath: folder,
          conversationIds: history.map((item) => item.id),
        });
      } catch {
        goals = [];
      }
    }
    return { ok: true, history, goals };
  }

  function continueHistory(payload = {}) {
    if (!open()) return disabled();
    const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId.trim() : '';
    const workspaceId = typeof payload?.workspaceId === 'string' ? payload.workspaceId.trim() : '';
    if (!conversationId || !workspaceId) return { ok: false, code: 'INVALID_INPUT' };
    if (!conversationStore
      || typeof conversationStore.getConversation !== 'function'
      || typeof conversationStore.getPersistedConversationHistory !== 'function'
      || typeof conversationStore.captureInheritedBackground !== 'function') {
      return { ok: false, code: 'CONVERSATION_REQUIRED' };
    }
    const meta = conversationStore.getConversation(conversationId);
    if (!meta) return { ok: false, code: 'NOT_FOUND' };
    if (typeof meta.role === 'string' && meta.role.trim()) return { ok: false, code: 'NOT_HISTORY' };
    if (meta.status === 'archived') return { ok: false, code: 'ARCHIVED' };
    const history = conversationStore.getPersistedConversationHistory(conversationId);
    if (!history) return { ok: false, code: 'NOT_FOUND' };
    const capturedAt = typeof now === 'function' ? now() : new Date().toISOString();
    let captured = null;
    try {
      captured = conversationStore.captureInheritedBackground(conversationId, {
        expectedRevision: history.contentRevision,
        runtimeState: {
          conversationId,
          contentRevision: history.contentRevision,
          status: 'idle',
        },
        capturedAt,
      });
    } catch (error) {
      return { ok: false, code: error?.code || 'SNAPSHOT_FAILED', message: error?.message || 'snapshot failed' };
    }
    if (!captured?.snapshotId) return { ok: false, code: 'SNAPSHOT_FAILED' };
    if (captured.snapshot?.requiresMissingConfirmation === true && payload.confirmMissing !== true) {
      return {
        ok: false,
        code: 'BACKGROUND_CONFIRMATION_REQUIRED',
        snapshot: { snapshotId: captured.snapshotId },
      };
    }
    const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : '这段对话';
    const text = typeof payload.text === 'string' && payload.text.trim() ? payload.text.trim() : `继续：${title}`;
    const inputId = typeof payload.inputId === 'string' && payload.inputId.trim() ? payload.inputId.trim() : randomUUID();
    try {
      const input = inputQueue.submitInput({
        workspaceId,
        inputId,
        surface: 'desktop',
        text,
        historyRef: conversationId,
        historySnapshotId: captured.snapshotId,
        ...(captured.snapshot?.requiresMissingConfirmation === true ? { historyConfirmed: true } : {}),
      });
      if (typeof wake === 'function') {
        try { wake(workspaceId); } catch { /* 唤醒失败不回滚已经入队的输入 */ }
      }
      queueConversation(workspaceId);
      queueChanged(workspaceId);
      return { ok: true, input, snapshot: { snapshotId: captured.snapshotId } };
    } catch (error) {
      return { ok: false, code: 'INVALID_INPUT', message: error?.message || 'invalid input' };
    }
  }

  async function startFamiliarize(payload = {}) {
    if (!open()) return disabled();
    if (typeof lifecycle?.startFamiliarize !== 'function') return { ok: false, code: 'FAMILIARIZE_UNAVAILABLE' };
    const result = await lifecycle.startFamiliarize(payload.workspaceId);
    if (result?.ok) {
      queueChanged(payload.workspaceId);
      queueConversation(payload.workspaceId);
    }
    return result;
  }

  async function confirmResult(payload = {}) {
    if (!open()) return disabled();
    const session = sessions?.get?.({ sessionId: payload.sessionId });
    if (!payload.workspaceId || session?.workspaceId !== payload.workspaceId) return { ok: false, code: 'NOT_FOUND' };
    if (payload.stage && !['manual_completion', 'result_acceptance'].includes(payload.stage)) return { ok: false, code: 'INVALID_INPUT' };
    const result = payload.stage === 'manual_completion'
      ? await sessions.confirmCompletion({ sessionId: payload.sessionId, reviewToken: payload.reviewToken })
      : await sessions.confirmResult(payload.sessionId);
    queueChanged(payload.workspaceId); queueConversation(payload.workspaceId);
    if (!result?.ok) return { ok: false, code: result?.error || 'NOT_CONFIRMABLE' };
    return result;
  }

  async function acceptReadme(payload = {}) {
    if (!open()) return disabled();
    if (!directory.get(payload.workspaceId)?.ok) return { ok: false, code: 'NOT_FOUND' };
    const result = await lifecycle.acceptReadme(payload.workspaceId);
    if (result?.ok) { queueChanged(payload.workspaceId); queueConversation(payload.workspaceId); }
    return result;
  }

  async function retry(payload = {}) {
    if (!open()) return disabled();
    if (!directory.get(payload.workspaceId)?.ok || !payload.turnId) return { ok: false, code: 'NOT_FOUND' };
    if (typeof retryTurn !== 'function') return { ok: false, code: 'RETRY_UNAVAILABLE' };
    const key = `${payload.workspaceId}:${payload.turnId}`;
    if (retrying.has(key)) return retrying.get(key);
    const promise = Promise.resolve().then(() => retryTurn(payload)).finally(() => retrying.delete(key));
    retrying.set(key, promise);
    const result = await promise;
    if (result?.ok) { queueChanged(payload.workspaceId); queueConversation(payload.workspaceId); }
    return result;
  }

  function readEvidence(payload = {}) {
    if (!open()) return disabled();
    if (Array.isArray(payload.evidenceRefs)) {
      if (payload.evidenceRef !== undefined || payload.evidenceRefs.length > 100
        || !payload.evidenceRefs.every(evidenceRefAllowed)) return { ok: false, code: 'INVALID_REF' };
      const refs = [...new Set(payload.evidenceRefs.map(ref => ref.trim()))];
      try {
        return { ok: true, items: refs.map(evidenceRef => readEvidenceBody?.(evidenceRef, { metadataOnly: true, ...(payload.context !== undefined ? { context: payload.context } : {}) })?.source ?? { evidenceRef }) };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    }
    const evidenceRef = typeof payload?.evidenceRef === 'string' ? payload.evidenceRef.trim() : '';
    if (!evidenceRefAllowed(evidenceRef)) return { ok: false, code: 'INVALID_REF' };
    if (typeof readEvidenceBody !== 'function') return { ok: false, evidenceRef, availability: 'unavailable', code: 'READ_FAILED' };
    try {
      const body = readEvidenceBody(evidenceRef, payload.context !== undefined ? { context: payload.context } : undefined);
      if (!body) return { ok: false, evidenceRef, availability: 'not_found', code: 'NOT_FOUND' };
      return { ...presentEvidence({ ...body, evidenceRef }), ...(payload.context !== undefined ? {
        deliveryStatus: body.deliveryStatus ?? 'unavailable', ...(body.deliveries ? { deliveries: body.deliveries } : {}),
        ...(body.code ? { code: body.code } : {}),
      } : {}) };
    } catch { return { ok: false, evidenceRef, availability: 'unavailable', code: 'READ_FAILED' }; }
  }

  async function takeoverHost(payload = {}) {
    if (!open()) return disabled();
    if (typeof payload.workspaceId !== 'string' || !payload.workspaceId.trim()) return { ok: false, code: 'INVALID_INPUT' };
    const got = directory?.get?.(payload.workspaceId);
    if (!got?.ok) return { ok: false, code: 'NOT_FOUND' };
    if (typeof requestTakeover !== 'function') return { ok: false, code: 'HOST_UNAVAILABLE' };
    const result = await requestTakeover(payload.workspaceId);
    if (result?.reason === 'invalid') return { ok: false, code: 'INVALID_INPUT' };
    queueChanged(payload.workspaceId);
    return { ok: true, requested: result?.requested === true, ...(result?.reason === 'self' ? { alreadyHost: true } : {}) };
  }

  async function controlRecovery(payload = {}) {
    if (!open()) return disabled();
    if (typeof payload?.workspaceId !== 'string' || !directory?.get?.(payload.workspaceId)?.ok) return { ok: false, code: 'NOT_FOUND' };
    return recoveryControl?.execute(payload) ?? { ok: false, code: 'RECOVERY_UNAVAILABLE' };
  }

  return {
    diagnostics: (...args) => typeof diagnostics === 'function' ? diagnostics(...args) : { ok: false, code: 'DIAGNOSTICS_UNAVAILABLE' },
    takeoverHost,
    controlRecovery,
    dispose: () => expiry.dispose(),
    list,
    listAttention,
    get,
    readAccessPolicy: accessPolicy.read,
    updateAccessPolicy: accessPolicy.update,
    readAvatar,
    create,
    updateProfile,
    updateModelSelection: createBotModelSelectionUpdater({ get, updateProfile }),
    deleteBot,
    submitInput,
    readInputDraft: payload => draftRequest(payload, 'read'),
    writeInputDraft: payload => draftRequest(payload, 'write'),
    readConversation,
    stopResponse,
    listSessions,
    getSession,
    cancelSession,
    resumeSession,
    listApprovals,
    decideApproval,
    markRead,
    search,
    readEvidence,
    listHistory,
    continueHistory,
    startFamiliarize,
    confirmResult,
    acceptReadme,
    retry,
  };
}
