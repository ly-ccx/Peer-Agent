import { createHash } from 'node:crypto';

import { createEvidenceBundle } from '@peer-agent/runtime-core';
import { createDurableGoalIdempotencyLedger } from '@peer-agent/runtime-core/goal-idempotency-durable';

import { createPermissionGrant } from '../tool-result-factory.mjs';
import { isProjectAgentTurn } from './mode-policy.mjs';
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
export function createDelegationProvider({
  supervisor = null,
  replyComposer = null,
  checkModel = null,
  ledger = null,
  storeDir = null,
} = {}) {
  let memoryLedger = null;

  function ledgerFor(context) {
    if (typeof ledger === 'function') return ledger(context);
    if (ledger) return ledger;
    const scope = text(context?.workspaceId) || text(context?.conversationId);
    if (storeDir && scope) {
      return createDurableGoalIdempotencyLedger({
        storeDir,
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
      mode: context.mode ?? request?.mode,
      role: context.role ?? context.turnProfile?.role ?? request?.turnProfile?.role,
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
    if (item.name === 'spawn_session') {
      const anchorError = validateAnchors(input.anchorMessageIds, context.messages);
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

    const key = idempotencyKey({
      turnId: text(context.turnId) || '',
      toolCallOrdinal: context.toolCallOrdinal ?? '',
      name: item.name,
      input,
    });
    const book = ledgerFor(context);
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

    const dispatched = await dispatch(item.name, input);
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

  async function dispatch(name, input) {
    if (name === 'spawn_session') {
      return accepted(await callPort(supervisor?.spawn, input, 'supervisor_unavailable'), 'supervisor_unavailable');
    }
    if (name === 'list_sessions') {
      const rows = await callPort(supervisor?.list, input, 'supervisor_unavailable');
      if (!rows.ok) return rows;
      return { ok: true, output: { ok: true, sessions: Array.isArray(rows.output) ? rows.output : [] } };
    }
    if (name === 'get_session') return sessionOrMissing(await callPort(supervisor?.get, input, 'supervisor_unavailable'));
    if (name === 'cancel_session') return sessionOrMissing(await callPort(supervisor?.cancel, input, 'supervisor_unavailable'));
    if (name === 'message_session') return sessionOrMissing(await callPort(supervisor?.message, input, 'supervisor_unavailable'));
    return accepted(await callPort(replyComposer?.postReply, input, 'composer_unavailable'), 'composer_unavailable');
  }

  return {
    providerId: 'local.delegation',
    capabilityIds: [...DELEGATION_CAPABILITY_IDS],
    executeCapability,
  };
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

async function callPort(fn, input, unavailable) {
  if (typeof fn !== 'function') {
    return { ok: false, output: { ok: false, error: unavailable, message: unavailable } };
  }
  const result = await fn(input);
  if (result && result.error) {
    return {
      ok: false,
      output: {
        ok: false,
        error: result.error,
        ...(result.missing ? { missing: result.missing, message: result.missing } : {}),
        ...(result.message ? { message: result.message } : {}),
      },
    };
  }
  if (result == null) return { ok: true, output: null };
  return { ok: true, output: result };
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
