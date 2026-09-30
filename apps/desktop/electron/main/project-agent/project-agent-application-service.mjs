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
  projectClassicGoals,
  projectHistory,
} from '@peer-agent/runtime-node';
import { settleActivePermissionRequest, sharedOneTimeApprovals } from '../chat-runtime/permission-gate.mjs';
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
  }, { remember: grant?.remember === true });
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
} = {}) {
  let corpusToken = null;
  const pendingChanged = new Set();
  const pendingConversation = new Set();
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
    const status = readAgentStatus(item.workspaceId);
    if (!['idle', 'thinking', 'waiting_provider', 'error'].includes(status)) return item;
    return { ...item, state: { ...item.state, agentStatus: status } };
  }

  function list(payload = {}) {
    if (!open()) return disabled();
    const items = typeof payload?.query === 'string' && payload.query.trim()
      ? directory.search(payload.query)
      : directory.list();
    const filtered = payload?.needsYouOnly === true
      ? items.filter((item) => item.state.needsYou > 0)
      : items;
    return { ok: true, items: filtered.map(withAgentStatus) };
  }

  function get(payload = {}) {
    if (!open()) return disabled();
    const result = directory.get(payload.workspaceId);
    return result?.ok && result.item ? { ...result, item: withAgentStatus(result.item) } : result;
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
      const familiarize = lifecycle.startFamiliarize?.(bound.id) ?? null;
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
      const familiarize = lifecycle.startFamiliarize?.(workspaceId) ?? null;
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
    queueChanged(workspaceId);
    return { ok: true, profile: profileStore.read(workspaceId) };
  }

  function deleteBot(payload = {}) {
    if (!open()) return disabled();
    const result = lifecycle.deleteBot(payload.workspaceId, {
      confirmManaged: payload.confirmManaged === true,
    });
    if (result?.ok) queueChanged(payload.workspaceId);
    return result;
  }

  async function submitInput(payload = {}) {
    if (!open()) return disabled();
    try {
      const answerTo = typeof payload.answerTo === 'string' ? payload.answerTo.trim() : '';
      const input = inputQueue.submitInput({
        workspaceId: payload.workspaceId,
        inputId: payload.inputId,
        surface: payload.surface || 'desktop',
        text: payload.text,
        anchorRefs: payload.anchorRefs,
        quoteRefs: payload.quoteRefs,
        attachmentRefs: payload.attachmentRefs,
        createdAt: payload.createdAt,
        ...(answerTo ? { answerTo } : {}),
      });
      if (typeof wake === 'function') {
        try { wake(payload.workspaceId); } catch { /* 唤醒失败不回滚已经入队的输入 */ }
      }
      queueConversation(payload.workspaceId);
      queueChanged(payload.workspaceId);
      let delivery = 'queued';
      if (answerTo && agentOnline(payload.workspaceId) !== true && typeof sessions?.deliverAnswer === 'function') {
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
      return { ok: false, code: 'INVALID_INPUT', message: error?.message || 'invalid input' };
    }
  }

  function readConversation(payload = {}) {
    if (!open()) return disabled();
    return directory.readConversation(payload.workspaceId, payload);
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
    queueChanged(payload.workspaceId || session.workspaceId);
    return { ok: true, session };
  }

  function listApprovals(payload = {}) {
    if (!open()) return disabled();
    return { ok: true, approvals: approvals.list(payload) };
  }

  async function decideApproval(payload = {}) {
    if (!open()) return disabled();
    const decision = payload.decision === 'approve'
      ? 'approved'
      : (payload.decision === 'reject' || payload.decision === 'deny' ? 'denied' : '');
    if (!decision) return { ok: false, code: 'INVALID_INPUT' };
    const listed = approvals.list({ workspaceId: payload.workspaceId });
    const current = listed.find((item) => item.approvalId === payload.approvalId);
    if (!current) return { ok: false, code: 'NOT_FOUND' };
    if (current.state === 'approved' || current.state === 'denied' || current.state === 'expired') {
      return { ok: true, approval: current };
    }
    const duration = decision !== 'approved'
      ? 'denied'
      : payload.duration === 'task'
        ? 'task'
        : 'once';
    const plan = isPlanApproval(current);
    let resumed = null;
    if (decision === 'approved' && (plan || current.state === 'stale')) {
      if (!plan && current.state === 'stale' && typeof rememberGrant === 'function') {
        try {
          rememberGrant({
            capabilityId: current.capabilityId,
            argsDigest: current.argsDigest,
            sessionId: current.sessionId,
            workspaceId: current.workspaceId,
            at: Date.now(),
          });
        } catch {
          // 授权簿写失败时仍然记下决定，恢复路径还能再问一次。
        }
      }
      if (typeof sessions?.resumeFromApproval === 'function') {
        try {
          resumed = await sessions.resumeFromApproval(current);
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
    } else if (current.state === 'open' && !plan && typeof settleLive === 'function') {
      try {
        settleLive(current, {
          decision,
          duration,
          remember: decision === 'approved' && duration === 'task',
        });
      } catch {
        // 现场请求已经不在时，持久记录仍然是两处共同的事实。
      }
    }
    const saved = approvals.append({
      ...current,
      state: decision,
      decidedAt: typeof now === 'function' ? now() : now,
      decidedBy: 'local_ui',
    });
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
      queueChanged(payload.workspaceId);
      if (typeof onViewing === 'function') onViewing(payload.workspaceId);
    }
    return marked;
  }

  function search(payload = {}) {
    if (!open()) return disabled();
    const items = typeof directory?.search === 'function' ? directory.search(payload.query) : [];
    let hits = [];
    if (searchIndex && typeof readSearchCorpus === 'function') {
      try {
        const token = typeof corpusStamp === 'function' ? String(corpusStamp() ?? '') : null;
        if (token === null || token !== corpusToken) {
          searchIndex.sync(collectConversationSearchDocuments(readSearchCorpus() || {}));
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

  function startFamiliarize(payload = {}) {
    if (!open()) return disabled();
    if (typeof lifecycle?.startFamiliarize !== 'function') return { ok: false, code: 'FAMILIARIZE_UNAVAILABLE' };
    const result = lifecycle.startFamiliarize(payload.workspaceId);
    if (result?.ok) {
      queueChanged(payload.workspaceId);
      queueConversation(payload.workspaceId);
    }
    return result;
  }

  function readEvidence(payload = {}) {
    if (!open()) return disabled();
    const evidenceRef = typeof payload?.evidenceRef === 'string' ? payload.evidenceRef.trim() : '';
    if (!evidenceRefAllowed(evidenceRef)) return { ok: false, code: 'INVALID_REF' };
    if (typeof readEvidenceBody !== 'function') return { ok: false, code: 'NOT_FOUND' };
    const body = readEvidenceBody(evidenceRef);
    if (!body) return { ok: false, code: 'NOT_FOUND' };
    return presentEvidence({ ...body, evidenceRef });
  }

  return {
    list,
    get,
    readAvatar,
    create,
    updateProfile,
    deleteBot,
    submitInput,
    readConversation,
    listSessions,
    getSession,
    cancelSession,
    listApprovals,
    decideApproval,
    markRead,
    search,
    readEvidence,
    listHistory,
    continueHistory,
    startFamiliarize,
  };
}
