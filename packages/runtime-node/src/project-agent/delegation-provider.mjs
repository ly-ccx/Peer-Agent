import { createHash } from 'node:crypto';

import { createEvidenceBundle } from '@peer-agent/runtime-core';
import { createDurableGoalIdempotencyLedger } from '@peer-agent/runtime-core/goal-idempotency-durable';

import { createPermissionGrant } from '../tool-result-factory.mjs';
import { resolveAnchorScope } from './anchor-scope.mjs';
import { verdictRefFor } from './acceptance.mjs';
import { isProjectAgentTurn } from './mode-policy.mjs';
import { computeVerificationVerdict } from './verification-verdict.mjs';
import {
  DELEGATION_CAPABILITY_IDS,
  delegationSpecByCapability,
  validateDelegationInput,
} from './tool-specs.mjs';

const RESULT_PREFIX = 'delegation-result:';

/**
 * 调度能力。校验、幂等、自授权和 Evidence 在这里完成。
 * spawn 交给 SessionSupervisor，post_reply 交给 ReplyComposer；两者未接入时返回结构化错误，不留下半次调用。
 */
const OUTPUT_LIMIT = 2000;

export function createDelegationProvider({
  supervisor = null,
  replyComposer = null,
  verification = null,
  proactivity = null,
  checkModel = null,
  ledger = null,
  storeDir = null,
} = {}) {
  let memoryLedger = null;

  function ledgerFor(context) {
    if (typeof ledger === 'function') return ledger(context);
    if (ledger) return ledger;
    const scope = text(context?.workspaceId) || text(context?.conversationId);
    const directory = typeof storeDir === 'function' ? storeDir() : storeDir;
    if (directory && scope) {
      return createDurableGoalIdempotencyLedger({
        storeDir: directory,
        planId: scope,
        runId: 'delegation',
      });
    }
    if (!memoryLedger) {
      memoryLedger = createDurableGoalIdempotencyLedger({ storeDir: '', planId: '', runId: '' });
    }
    return memoryLedger;
  }

  async function executeCapability(request, context = {}) {
    const call = request?.call ?? {};
    const capabilityId = call.capabilityId;
    const item = delegationSpecByCapability(capabilityId);
    const view = executionView(context);
    const locale = context.locale === 'en-US' ? 'en-US' : 'zh-CN';
    if (!item) {
      return finish({
        call,
        capabilityId: capabilityId || 'local.delegation',
        name: 'delegation',
        locale,
        status: 'failed',
        output: { ok: false, error: 'invalid_input', message: 'Unknown delegation capability.' },
      });
    }
    if (!isProjectAgentTurn({
      mode: view.mode ?? request?.mode,
      role: view.role ?? request?.turnProfile?.role,
    })) {
      return finish({
        call,
        capabilityId,
        name: item.name,
        locale,
        status: 'failed',
        output: {
          ok: false,
          error: 'depth_limit',
          message: locale === 'zh-CN'
            ? '只有项目代理可以调度任务。'
            : 'Only the project agent can dispatch work.',
        },
      });
    }

    const validated = validateDelegationInput(item.name, parseArgs(call));
    if (!validated.ok) {
      return finish({
        call,
        capabilityId,
        name: item.name,
        locale,
        status: 'failed',
        output: { ok: false, error: validated.error, message: validated.message },
      });
    }

    const input = validated.value;
    if (['message_session', 'cancel_session', 'verify_session', 'resume_session', 'reprioritize_session'].includes(item.name) || item.name === 'spawn_session' && input.supersedes) {
      const scope = resolveAnchorScope({
        messages: view.messages,
        quoteRefs: view.quoteRefs,
        replyTo: view.replyTo,
      });
      if (scope.scoped && !scope.sessionIds.includes(input.sessionId || input.supersedes)) {
        return finish({
          call,
          capabilityId,
          name: item.name,
          locale,
          status: 'failed',
          output: {
            ok: false,
            error: 'out_of_scope',
            sessionId: input.sessionId,
            sessionIds: scope.sessionIds,
            message: locale === 'zh-CN'
              ? '这句话针对的是引用里的任务，没有影响其他任务。先向用户确认。'
              : 'This message is limited to the quoted tasks and did not affect that one. Confirm with the user.',
          },
        });
      }
    }
    if (item.name === 'set_proactivity' || item.name === 'resume_session') {
      const anchorError = validateAnchors([input.anchorMessageId], view.messages);
      if (anchorError) {
        return finish({
          call,
          capabilityId,
          name: item.name,
          locale,
          status: 'failed',
          output: anchorError,
        });
      }
    }
    if (item.name === 'spawn_session') {
      const anchorError = validateAnchors(input.anchorMessageIds, view.messages);
      if (anchorError) {
        return finish({
          call,
          capabilityId,
          name: item.name,
          locale,
          status: 'failed',
          output: anchorError,
        });
      }
      if (input.modelPreference?.modelProviderId && typeof checkModel === 'function') {
        const checked = await checkModel({ modelProviderId: input.modelPreference.modelProviderId });
        if (checked && checked.ok === false) {
          return finish({
            call,
            capabilityId,
            name: item.name,
            locale,
            status: 'failed',
            output: {
              ok: false,
              error: 'model_unavailable',
              missing: typeof checked.missing === 'string' ? checked.missing : 'model unavailable',
              message: typeof checked.missing === 'string' ? checked.missing : 'model unavailable',
            },
          });
        }
      }
    }

    if (input.sessionId && typeof supervisor?.get === 'function') {
      const session = await supervisor.get({ sessionId: input.sessionId });
      if (session?.workspaceId && view.workspaceId && session.workspaceId !== view.workspaceId) {
        return finish({ call, capabilityId, name: item.name, locale, status: 'failed', output: { ok: false, error: 'out_of_scope' } });
      }
    }

    const key = idempotencyKey({
      turnId: view.turnId,
      toolCallOrdinal: view.toolCallOrdinal,
      name: item.name,
      input,
    });
    const book = ledgerFor({ ...context, workspaceId: view.workspaceId, conversationId: view.conversationId });
    const previous = readResult(book?.get?.(key));
    if (previous) {
      return finish({
        call,
        capabilityId,
        name: item.name,
        locale,
        status: 'success',
        output: { ...previous, replayed: true },
      });
    }

    const dispatched = await dispatch(item.name, input, view);
    if (!dispatched.ok) {
      return finish({
        call,
        capabilityId,
        name: item.name,
        locale,
        status: 'failed',
        output: dispatched.output,
      });
    }
    book?.remember?.({
      idempotencyKey: key,
      status: 'completed',
      toolCallId: call.toolCallId,
      toolName: item.name,
      evidenceRefs: [`${RESULT_PREFIX}${encodeURIComponent(JSON.stringify(dispatched.output))}`],
    });
    return finish({
      call,
      capabilityId,
      name: item.name,
      locale,
      status: 'success',
      output: dispatched.output,
    });
  }

  async function dispatch(name, input, view) {
    if (name === 'spawn_session') {
      return accepted(
        await callPort(supervisor?.spawn, input, 'supervisor_unavailable', spawnContext(view)),
        'supervisor_unavailable',
      );
    }
    if (name === 'list_sessions') {
      const rows = await callPort(supervisor?.list, { ...input, workspaceId: view.workspaceId }, 'supervisor_unavailable');
      if (!rows.ok) return rows;
      return { ok: true, output: { ok: true, sessions: Array.isArray(rows.output) ? rows.output : [] } };
    }
    if (name === 'resume_session') return sessionOrMissing(await callPort(supervisor?.resume, input, 'supervisor_unavailable', spawnContext(view)));
    if (name === 'reprioritize_session') return sessionOrMissing(await callPort(supervisor?.reprioritize, input, 'supervisor_unavailable', spawnContext(view)));
    if (name === 'get_session') return sessionOrMissing(await callPort(supervisor?.get, input, 'supervisor_unavailable'));
    if (name === 'cancel_session') return sessionOrMissing(await callPort(supervisor?.cancel, input, 'supervisor_unavailable'));
    if (name === 'message_session') return sessionOrMissing(await callPort(supervisor?.message, input, 'supervisor_unavailable'));
    if (name === 'get_verification_detail') return readVerification(input);
    if (name === 'verify_session') return verifySession(input);
    if (name === 'set_proactivity') return setProactivity(input, view);
    if (name === 'post_reply') {
      const post = replyComposer?.postReply;
      return accepted(await callPort(
        typeof post === 'function' ? (payload) => post(payload, view) : null,
        input,
        'composer_unavailable',
      ), 'composer_unavailable');
    }
    return accepted(await callPort(null, input, 'composer_unavailable'), 'composer_unavailable');
  }

  function verificationAvailable() {
    if (!verification || typeof verification !== 'object') return false;
    if (typeof verification.available === 'function' && verification.available() !== true) return false;
    return true;
  }

  async function readVerification(input) {
    if (!verificationAvailable() || typeof verification?.facts !== 'function') {
      return { ok: false, output: { ok: false, error: 'verification_unavailable', message: 'verification_unavailable' } };
    }
    const facts = await verification.facts(input.sessionId);
    if (!facts) {
      return { ok: false, output: { ok: false, error: 'session_not_found', message: 'Session was not found.' } };
    }
    return { ok: true, output: { ok: true, ...buildVerificationDetail({ ...facts, sessionId: input.sessionId }) } };
  }

  async function verifySession(input) {
    if (!verificationAvailable() || typeof verification?.run !== 'function') {
      return { ok: false, output: { ok: false, error: 'verifier_unavailable', message: 'verifier_unavailable' } };
    }
    if (typeof verification.markVerifying === 'function') {
      await verification.markVerifying(input.sessionId);
    }
    const reviewed = await verification.run({
      sessionId: input.sessionId,
      ...(input.focus ? { focus: input.focus } : {}),
      role: 'verifier',
      preferDifferentSource: true,
    });
    if (!reviewed || reviewed.ok === false || !reviewed.facts) {
      return {
        ok: false,
        output: { ok: false, error: reviewed?.error || 'verifier_failed', message: reviewed?.error || 'verifier_failed' },
      };
    }
    const detail = buildVerificationDetail({ ...reviewed.facts, sessionId: input.sessionId });
    const event = {
      kind: 'verdict',
      sessionId: input.sessionId,
      outcome: detail.outcome,
      verdictRef: verdictRefFor(input.sessionId, detail.outcome),
      at: typeof reviewed.at === 'string' ? reviewed.at : new Date().toISOString(),
    };
    const card = {
      cardId: `card:verdict:${input.sessionId}`,
      kind: 'verdict',
      sessionId: input.sessionId,
      content: detail.outcome,
      verdictRef: event.verdictRef,
      resolvedState: 'resolved',
    };
    if (typeof verification.record === 'function') {
      await verification.record({ event, card, detail, status: 'verifying' });
    }
    return { ok: true, output: { ok: true, status: 'verifying', event, card, detail } };
  }

  async function setProactivity(input, view) {
    const workspaceId = text(view?.workspaceId);
    if (!workspaceId) {
      return { ok: false, output: { ok: false, error: 'project_required', message: 'project_required' } };
    }
    if (!proactivity || typeof proactivity.set !== 'function'
      || (typeof proactivity.available === 'function' && proactivity.available() !== true)) {
      return { ok: false, output: { ok: false, error: 'proactivity_unavailable', message: 'proactivity_unavailable' } };
    }
    const saved = await proactivity.set({
      workspaceId,
      level: input.level,
      anchorMessageId: input.anchorMessageId,
    });
    if (!saved || saved.ok === false) {
      return {
        ok: false,
        output: { ok: false, error: saved?.error || 'proactivity_failed', message: saved?.error || 'proactivity_failed' },
      };
    }
    return {
      ok: true,
      output: {
        ok: true,
        level: input.level,
        anchorMessageId: input.anchorMessageId,
        workspaceId,
      },
    };
  }

  return {
    providerId: 'local.delegation',
    capabilityIds: [...DELEGATION_CAPABILITY_IDS],
    executeCapability,
  };
}

function executionView(context) {
  const nested = context?.toolContext && typeof context.toolContext === 'object' && !Array.isArray(context.toolContext)
    ? context.toolContext
    : {};
  return {
    mode: context?.mode ?? nested.mode,
    role: context?.role ?? context?.turnProfile?.role ?? nested.role ?? nested.turnRole ?? nested.turnProfile?.role,
    messages: Array.isArray(context?.messages) ? context.messages : nested.messages,
    quoteRefs: context?.quoteRefs ?? nested.quoteRefs,
    replyTo: context?.replyTo ?? nested.replyTo,
    turnId: text(context?.turnId) || text(nested.turnId) || '',
    toolCallOrdinal: context?.toolCallOrdinal ?? nested.toolCallOrdinal ?? '',
    workspaceId: text(context?.workspaceId) || text(nested.workspaceId),
    workspacePath: text(context?.workspacePath) || text(nested.workspacePath) || '',
    conversationId: text(context?.conversationId) || text(nested.conversationId),
    memoryIds: idList(context?.turnMemoryIds ?? nested.turnMemoryIds),
    turnToolCalls: Array.isArray(context?.turnToolCalls)
      ? context.turnToolCalls.slice()
      : (Array.isArray(nested.turnToolCalls) ? nested.turnToolCalls.slice() : []),
  };
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    const id = text(item);
    if (!id || id.length > 200 || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= 200) break;
  }
  return ids;
}

function parseArgs(call) {
  const raw = call?.arguments;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function idempotencyKey({ turnId, toolCallOrdinal, name, input }) {
  const material = `${turnId}\u0001${toolCallOrdinal}\u0001${name}\u0001${canonical(input)}`;
  return createHash('sha256').update(material).digest('hex');
}

function validateAnchors(ids, messages) {
  const byId = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const id = text(message?.id) || text(message?.messageId);
    if (id) byId.set(id, message);
  }
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      error: 'anchor_not_found',
      messageIds: missing,
      message: 'Anchor message was not found in this conversation.',
    };
  }
  const rejected = ids.filter((id) => !isUserInput(byId.get(id)));
  if (rejected.length > 0) {
    return {
      ok: false,
      error: 'anchor_not_user_input',
      messageIds: rejected,
      message: 'Anchor message must be a user_input message.',
    };
  }
  return null;
}

function isUserInput(message) {
  const kind = message?.kind || message?.type || message?.messageKind;
  if (kind === 'user_input') return true;
  if (typeof kind === 'string' && kind) return false;
  return message?.role === 'user';
}

function readResult(entry) {
  const ref = entry?.evidenceRefs?.find((item) => typeof item === 'string' && item.startsWith(RESULT_PREFIX));
  if (!ref) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(ref.slice(RESULT_PREFIX.length)));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function callPort(fn, input, unavailable, context) {
  if (typeof fn !== 'function') {
    return { ok: false, output: { ok: false, error: unavailable, message: unavailable } };
  }
  const result = context === undefined ? await fn(input) : await fn(input, context);
  if (result && result.error) {
    return {
      ok: false,
      output: {
        ok: false,
        error: result.error,
        ...(Array.isArray(result.sessionStates) ? { sessionStates: result.sessionStates } : {}),
        ...(result.missing ? { missing: result.missing, message: result.missing } : {}),
        ...(result.message ? { message: result.message } : {}),
      },
    };
  }
  if (result == null) return { ok: true, output: null };
  return { ok: true, output: result };
}

function spawnContext(view) {
  return {
    parentConversationId: text(view?.conversationId) || '',
    workspaceId: text(view?.workspaceId) || '',
    workspacePath: text(view?.workspacePath) || '',
    ...historyCarry(view?.messages),
  };
}

function historyCarry(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!isUserInput(message)) continue;
    const historyRef = text(message?.historyRef);
    const historySnapshotId = text(message?.historySnapshotId);
    if (!historyRef || !historySnapshotId) return {};
    return {
      historyConversationId: historyRef,
      backgroundSnapshotId: historySnapshotId,
      ...(message.historyConfirmed === true ? { confirmMissing: true } : {}),
    };
  }
  return {};
}

function accepted(result, unavailable) {
  if (!result.ok) return result;
  if (!result.output || typeof result.output !== 'object') {
    return { ok: false, output: { ok: false, error: unavailable, message: unavailable } };
  }
  return { ok: true, output: { ok: true, ...result.output } };
}

function sessionOrMissing(result) {
  if (!result.ok) return result;
  if (result.output == null) {
    return {
      ok: false,
      output: {
        ok: false,
        error: 'session_not_found',
        message: 'Session was not found.',
      },
    };
  }
  return { ok: true, output: { ok: true, ...result.output } };
}

/**
 * 结论、检查和输出摘要只来自宿主证据索引。
 * 计划上的模型自述、runner.verifierRuns 和调用方塞进来的 modelClaim 都不读。
 */
export function buildVerificationDetail(facts = {}) {
  const plan = facts.plan && typeof facts.plan === 'object' ? facts.plan : {};
  const evidenceIndex = facts.evidenceIndex instanceof Set || Array.isArray(facts.evidenceIndex)
    ? facts.evidenceIndex
    : [];
  const authority = {};
  if (typeof facts.independentVerifier === 'string') authority.independentVerifier = facts.independentVerifier;
  if (typeof facts.verifierModel === 'string') authority.verifierModel = facts.verifierModel;
  if (typeof facts.sameFamilyAsWorker === 'boolean') authority.sameFamilyAsWorker = facts.sameFamilyAsWorker;
  const verdict = computeVerificationVerdict(plan, evidenceIndex, authority);
  const allowed = new Set(verdict.evidenceRefs);
  const outputs = [];
  for (const item of Array.isArray(facts.outputs) ? facts.outputs : []) {
    const evidenceRef = typeof item?.evidenceRef === 'string' ? item.evidenceRef.trim() : '';
    if (!evidenceRef || !allowed.has(evidenceRef)) continue;
    const body = typeof item.text === 'string' ? item.text : '';
    const summary = Array.from(body).slice(0, OUTPUT_LIMIT).join('');
    outputs.push({
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'output',
      evidenceRef,
      summary,
      truncated: body.length > summary.length,
    });
  }
  return {
    sessionId: typeof facts.sessionId === 'string' ? facts.sessionId : '',
    outcome: verdict.outcome,
    checks: verdict.checks.map((check) => ({
      name: check.name,
      result: check.passed === true ? 'passed' : 'failed',
      evidenceRefs: verdict.evidenceRefs,
      ...(check.reason ? { reason: check.reason } : {}),
    })),
    workerModel: typeof facts.workerModel === 'string' ? facts.workerModel : null,
    verifierModel: typeof authority.verifierModel === 'string' ? authority.verifierModel : null,
    sameSource: facts.sameFamilyAsWorker === true,
    outputs,
  };
}

function finish({ call, capabilityId, name, locale, status, output }) {
  const granted = status === 'success';
  const outputText = JSON.stringify(output);
  return {
    call,
    grant: {
      ...createPermissionGrant({
        toolCallId: call.toolCallId,
        granted,
        scope: capabilityId,
        duration: granted ? 'once' : 'denied',
      }),
      reason: 'project_agent_dispatch',
    },
    result: {
      toolCallId: call.toolCallId,
      status,
      outputPreview: {
        status,
        tool: name,
        legacyResult: { success: granted, output: outputText },
      },
      evidence: createEvidenceBundle({
        evidenceId: `delegation-${call.toolCallId || name}`,
        toolCallId: call.toolCallId,
        summary: locale === 'zh-CN'
          ? `调度 ${name}：${output.error || status}。`
          : `Delegation ${name}: ${output.error || status}.`,
        locale,
        returnedToCloud: false,
        dataLevel: 'D1_internal',
      }),
    },
  };
}
