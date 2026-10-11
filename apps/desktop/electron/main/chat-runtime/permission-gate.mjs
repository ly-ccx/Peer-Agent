import { createPendingPermissionWait } from './pending-permission-wait.mjs';
import { createOneTimeApprovalBook } from '@peer-agent/runtime-node';
export { createOneTimeApprovalBook } from '@peer-agent/runtime-node';
import { evaluateObjectiveProbeCall } from './objective-probe-gate.mjs';
import { randomUUID } from 'node:crypto';
import { digestApprovalArgs, createImageReadAuthority, permissionOperationKey } from '@peer-agent/runtime-node';
import { SHARED_LOCAL_TOOL_CONTRACTS } from '@peer-agent/runtime-core';

export const sharedOneTimeApprovals = createOneTimeApprovalBook();
let activeGate = null;

export function settleActivePermissionRequest(toolCallId, grant, options) {
  if (!activeGate || typeof activeGate.settlePermissionRequest !== 'function') return false;
  return activeGate.settlePermissionRequest(toolCallId, grant, options);
}

const LOCAL_ACCESS_LEVELS = new Set([
  'ask_before_local',
  'session_local',
  'restricted_local',
  'full_local',
]);

const SHELL_RISK_ORDER = {
  L0_inert: 0,
  L1_local_read: 1,
  L2_local_write: 2,
  L3_external_write: 3,
  L4_privileged: 4,
  L5_destructive: 5,
};

function normalizeLocalAccessLevel(value) {
  return typeof value === 'string' && LOCAL_ACCESS_LEVELS.has(value) ? value : 'ask_before_local';
}

function compareShellRisk(left, right) {
  return (SHELL_RISK_ORDER[left] ?? SHELL_RISK_ORDER.L4_privileged) -
    (SHELL_RISK_ORDER[right] ?? SHELL_RISK_ORDER.L4_privileged);
}

function buildFilePermissionCall({ tool, args, filePath, workspacePath, toolCallId }) {
  const contract = Object.values(SHARED_LOCAL_TOOL_CONTRACTS).find(item => item.toolName === tool && item.capabilityId.startsWith('local.file.'));
  const capabilityId = contract?.capabilityId ?? 'local.file.write';
  const action = capabilityId.slice('local.file.'.length);
  const readOnly = ['read', 'list', 'search'].includes(action);
  return {
    toolCallId: `chat-permission:${toolCallId || randomUUID()}`,
    capabilityId,
    displayName: tool,
    reason: `The ${tool} tool wants to ${readOnly ? action : 'modify'} outside the active workspace.`,
    arguments: {
      tool,
      path: filePath,
      workspacePath,
      args,
    },
    argumentsPreview: {
      command: `${action} ${filePath}`,
      action,
      path: filePath,
      workspacePath,
    },
    riskLevel: readOnly ? 'L1_local_read' : 'L2_local_write',
    dataLevel: 'D2_sensitive',
    requestedAt: new Date().toISOString(),
  };
}

function buildShellPermissionCall({ call, classification, ruleDecision, toolCallId }) {
  return {
    toolCallId: `chat-permission:${toolCallId || call?.toolCallId || randomUUID()}`,
    capabilityId: 'local.shell.exec',
    displayName: 'bash',
    reason: `The bash tool wants to execute a ${classification.category} command.`,
    arguments: {
      command: classification.command,
      cwd: classification.cwd,
      classification,
      ruleDecision,
    },
    argumentsPreview: {
      command: classification.command,
      cwd: classification.cwd,
      category: classification.category,
      riskLevel: classification.riskLevel,
      reason: classification.reason,
    },
    riskLevel: classification.riskLevel,
    dataLevel: classification.dataLevel,
    requestedAt: new Date().toISOString(),
  };
}

function buildLocalCapabilityPermissionCall({ request, toolCallId }) {
  return {
    toolCallId: `chat-permission:${toolCallId || request?.toolCallId || randomUUID()}`,
    capabilityId: request?.capabilityId || 'local.capability',
    displayName: request?.toolName || request?.displayName || request?.capabilityId || 'local capability',
    reason: request?.reason || 'The assistant wants to use a local capability.',
    arguments: request?.args ?? {},
    argumentsPreview: request?.scope ?? request?.args ?? {},
    confirmation: request?.confirmation ?? undefined,
    riskLevel: request?.riskLevel ?? 'L3_external_write',
    dataLevel: request?.dataLevel ?? 'D2_sensitive',
    requestedAt: new Date().toISOString(),
  };
}

function isReusablePermissionType(call) {
  return !call?.confirmation && call?.argumentsPreview?.kind !== 'goal-confirmation'
    && ['local.file.edit', 'local.file.write', 'local.shell.exec', 'local.image.read'].includes(call?.capabilityId);
}

function buildPermissionScopeKey({ conversationId, workspacePath, call, sessionId, planId }) {
  return permissionOperationKey({ capabilityId: call.capabilityId,
    args: call.capabilityId === 'local.image.read' ? { args: call.arguments, scope: call.argumentsPreview } : call.arguments,
    conversationId, workspacePath, sessionId, planId });
}

const PERMISSION_ID_PREFIX = 'chat-permission:';

function sourceToolCallIdFromPermissionId(permissionId) {
  if (typeof permissionId !== 'string' || permissionId.length === 0) return null;
  return permissionId.startsWith(PERMISSION_ID_PREFIX)
    ? permissionId.slice(PERMISSION_ID_PREFIX.length)
    : permissionId;
}

function createAutoAccessGrant({ toolCallId, scope, reason }) {
  return {
    granted: true,
    grant: {
      grantId: `auto-${randomUUID()}`,
      toolCallId,
      granted: true,
      duration: 'once',
      scope,
      decidedAt: new Date().toISOString(),
    },
    reason,
  };
}

function maybeCreateAutoGrantForFile({ accessLevel, call }) {
  if (accessLevel !== 'full_local') return null;
  return createAutoAccessGrant({
    toolCallId: call.toolCallId,
    scope: call.capabilityId,
    reason: 'local_access_level_full',
  });
}

function shouldAutoApproveShellForAccessLevel(accessLevel, riskLevel) {
  if (accessLevel === 'full_local') return true;
  if (accessLevel !== 'session_local') return false;
  return compareShellRisk(riskLevel, 'L3_external_write') <= 0;
}

function maybeCreateAutoGrantForShell({ accessLevel, permissionCall, classification }) {
  if (!shouldAutoApproveShellForAccessLevel(accessLevel, classification?.riskLevel)) return null;
  return createAutoAccessGrant({
    toolCallId: permissionCall.toolCallId,
    scope: permissionCall.capabilityId,
    reason: accessLevel === 'full_local' ? 'local_access_level_full' : 'local_access_level_session',
  });
}

function createAutoScopeGrant({ toolCallId, scope }) {
  return {
    grantId: `auto-${randomUUID()}`,
    toolCallId,
    granted: true,
    duration: 'scope',
    scope,
    decidedAt: new Date().toISOString(),
  };
}

function createPolicyDenial({ toolCallId, reason }) {
  return {
    granted: false,
    grant: {
      grantId: `policy-${randomUUID()}`,
      toolCallId,
      granted: false,
      duration: 'once',
      scope: null,
      decidedAt: new Date().toISOString(),
    },
    reason,
  };
}

function automationCapabilityDecision(policy, call) {
  if(policy?.kind==='objective_probe'){const gate=evaluateObjectiveProbeCall({policy,call});return gate.allowed?createAutoAccessGrant({toolCallId:call.toolCallId,scope:call.capabilityId,reason:'objective_probe_observe'}):createPolicyDenial({toolCallId:call.toolCallId,reason:gate.reason});}
  if (policy?.kind !== 'automation') return null;
  if (policy.blockedCapabilityIds?.includes(call.capabilityId)) {
    return createPolicyDenial({ toolCallId: call.toolCallId, reason: 'automation_capability_blocked' });
  }
  if (policy.allowedCapabilityIds?.includes(call.capabilityId)) {
    return createAutoAccessGrant({
      toolCallId: call.toolCallId,
      scope: call.capabilityId,
      reason: 'automation_grant_allowed',
    });
  }
  return createPolicyDenial({
    toolCallId: call.toolCallId,
    reason: policy.preset === 'observe' ? 'automation_observe_read_only' : 'automation_capability_not_granted',
  });
}

function previewSummary(call) {
  const preview = call?.argumentsPreview;
  if (preview && typeof preview.command === 'string' && preview.command.trim()) return preview.command;
  if (typeof call?.reason === 'string' && call.reason.trim()) return call.reason;
  return call?.displayName || call?.capabilityId || '';
}

export function createChatPermissionGate({
  activeStreams,
  accessLevel: initialAccessLevel = 'ask_before_local',
  approvalStore = null,
  resolveApprovalScope = null,
  resolvePermissionPrincipal = null,
  settleNotifier = null,
  oneTimeApprovals = sharedOneTimeApprovals,
  now = () => Date.now(),
  permissionWaitMs,
  permissionTimers = {},
} = {}) {
  const pendingPermissionRequests = createPendingPermissionWait({ now, waitMs: permissionWaitMs,
    ...permissionTimers, onEnd: (id, grant, options) => settlePermissionRequest(id, grant, options) });
  const approvedPermissionScopes = new Map();
  const approvedSourceToolCalls = new Map();
  let accessLevel = normalizeLocalAccessLevel(initialAccessLevel);
  let policyEpoch = 0;
  let durableApprovals = approvalStore;
  let resolveScope = resolveApprovalScope;
  let resolvePrincipal = resolvePermissionPrincipal;
  let imageAuthority = createImageReadAuthority({ approvalStore, now });
  let notifySettled = settleNotifier;

  function configure(next = {}) {
    if (Object.prototype.hasOwnProperty.call(next, 'approvalStore')) {
      durableApprovals = next.approvalStore;
      imageAuthority = createImageReadAuthority({ approvalStore: durableApprovals, now });
    }
    if (Object.prototype.hasOwnProperty.call(next, 'resolvePermissionPrincipal')) resolvePrincipal = next.resolvePermissionPrincipal;
    if (Object.prototype.hasOwnProperty.call(next, 'resolveApprovalScope')) resolveScope = next.resolveApprovalScope;
    if (Object.prototype.hasOwnProperty.call(next, 'settleNotifier')) notifySettled = next.settleNotifier;
  }

  function recordApproval({
    call,
    streamId,
    conversationId,
    workspacePath,
    state,
    decidedBy = null,
    workspaceId = undefined,
    planId = undefined,
    argsDigest = undefined,
    createdAt = undefined,
    deadlineAt = undefined,
    decisionReason = undefined,
  }) {
    if (!durableApprovals || typeof durableApprovals.append !== 'function' || !call) return null;
    let scope = {};
    try {
      if ((workspaceId === undefined || planId === undefined) && typeof resolveScope === 'function') {
        scope = resolveScope({ conversationId, workspacePath, streamId, call }) || {};
      }
    } catch {
      scope = {};
    }
    const profile = activeStreams.get(streamId)?.turnProfile;
    const profileWorkspaceId = typeof profile?.workspaceId === 'string' ? profile.workspaceId.trim() : '';
    const profileSessionId = typeof profile?.sessionId === 'string' ? profile.sessionId.trim() : '';
    const profilePlanId = typeof profile?.planId === 'string' ? profile.planId.trim() : '';
    const record = {
      approvalId: call.toolCallId,
      workspaceId: profileWorkspaceId
        || (workspaceId !== undefined ? workspaceId : (scope.workspaceId ?? null))
        || null,
      ...(profileSessionId ? { sessionId: profileSessionId } : {}),
      conversationId: scope.conversationId ?? conversationId ?? null,
      streamId: streamId ?? null,
      planId: profilePlanId || (planId !== undefined ? planId : (scope.planId ?? null)) || null,
      capabilityId: call.capabilityId || 'unknown',
      ...(call.capabilityId === 'local.image.read' ? { imageReadScope: call.argumentsPreview } : {}),
      summary: previewSummary(call),
      riskLevel: call.riskLevel ?? null,
      argsDigest: argsDigest || digestApprovalArgs(call.arguments),
      createdAt: createdAt || call.requestedAt || new Date().toISOString(),
      state,
      ...(deadlineAt ? { deadlineAt } : {}),
      ...(decisionReason ? { decisionReason } : {}),
    };
    if (state !== 'open') {
      record.decidedAt = new Date(Number(now())).toISOString();
      record.decidedBy = decidedBy || 'local_ui';
    }
    try {
      return durableApprovals.append(record);
    } catch (error) {
      console.warn('[permission-gate] approval record failed:', error?.message || error);
      return null;
    }
  }

  function scopeKeyFor(context) {
    const profile = activeStreams.get(context.streamId)?.turnProfile;
    return buildPermissionScopeKey({ ...context, sessionId: profile?.sessionId, planId: profile?.planId });
  }

  function principalFor(context) {
    if (typeof resolvePrincipal === 'function') return resolvePrincipal(context);
    const profile = activeStreams.get(context.streamId)?.turnProfile;
    if (profile?.planId) return null; // Delegated identity needs host GoalPlan validation.
    return context.conversationId ? { workspaceId: profile?.workspaceId ?? null, conversationId: context.conversationId } : null;
  }

  function reuseApprovedSourceToolCall(call, context) {
    const sourceId = sourceToolCallIdFromPermissionId(call?.toolCallId);
    const remembered = sourceId ? approvedSourceToolCalls.get(sourceId) : null;
    const sourceCall = remembered?.confirmation && context.sourceArguments !== undefined ? { ...call, arguments: context.sourceArguments } : call;
    const key = scopeKeyFor({ ...context, call: sourceCall });
    if (!remembered?.grant?.granted || remembered.key !== key || remembered.expiresAt <= Number(now())) return null;
    approvedSourceToolCalls.delete(sourceId); // Single recovery / confirmation handoff.
    return { granted: true, grant: { ...remembered.grant, toolCallId: call.toolCallId, duration: 'once' },
      reason: 'local_user_approved_same_tool_call' };
  }

  function setAccessLevel(nextAccessLevel) {
    const next = normalizeLocalAccessLevel(nextAccessLevel);
    if (next !== accessLevel) {
      policyEpoch++;
      approvedPermissionScopes.clear(); approvedSourceToolCalls.clear();
      imageAuthority.revokeAll();
    }
    accessLevel = next;
    return accessLevel;
  }

  function registerPendingPermission({
    streamId,
    call,
    scopeKey,
    scope,
    resolve,
    webContents = null,
    conversationId = null,
    approval = null,
    workspacePath = null,
    signal = null,
    deadlineAt,
  }) {
    const active = activeStreams.get(streamId);
    if (active) {
      if (!active.permissionIds) active.permissionIds = new Set();
      active.permissionIds.add(call.toolCallId);
    }
    pendingPermissionRequests.add(call.toolCallId, {
      streamId,
      call,
      conversationId,
      scopeKey,
      scope,
      workspacePath,
      resolve,
      webContents,
      reusable: isReusablePermissionType(call),
      approval,
      deadlineAt,
      signal: signal ?? active?.runtimeTurn?.signal,
    });
  }

  function askUser({
    webContents,
    streamId,
    call,
    scopeKey,
    scope,
    resolve,
    conversationId = null,
    workspacePath = null,
    signal = null,
  }) {
    const at = Number(now());
    const argsDigest = digestApprovalArgs(call?.arguments);
    const profile = activeStreams.get(streamId)?.turnProfile;
    const sessionId = typeof profile?.sessionId === 'string' ? profile.sessionId.trim() : '';
    const grantWorkspaceId = typeof profile?.workspaceId === 'string' ? profile.workspaceId.trim() : '';
    if (oneTimeApprovals?.match?.({
      capabilityId: call?.capabilityId,
      argsDigest,
      at,
      sessionId,
      workspaceId: grantWorkspaceId,
    })) {
      resolve({
        granted: true,
        grant: {
          grantId: `once-${randomUUID()}`,
          toolCallId: call.toolCallId,
          granted: true,
          duration: 'once',
          scope: call.capabilityId,
          decidedAt: new Date(at).toISOString(),
        },
        reason: 'local_user_approved_once',
      });
      recordApproval({
        call,
        streamId,
        conversationId,
        workspacePath,
        state: 'approved',
        decidedBy: 'local_ui',
        argsDigest,
      });
      return;
    }
    const approver = webContents?.approver ?? activeStreams.get(streamId)?.approver;
    if (approver === 'none') {
      resolve(createPolicyDenial({
        toolCallId: call.toolCallId,
        reason: 'ephemeral_no_approver',
      }));
      recordApproval({
        call,
        streamId,
        conversationId,
        workspacePath,
        state: 'denied',
        decidedBy: 'policy',
      });
      return;
    }
    const deadlineAt = pendingPermissionRequests.deadlineAt();
    const approval = recordApproval({ call, streamId, conversationId, workspacePath, state: 'open', deadlineAt });
    if (durableApprovals && !approval) {
      resolve(createPolicyDenial({ toolCallId: call.toolCallId, reason: 'permission_unavailable' }));
      return;
    }
    registerPendingPermission({
      streamId,
      call,
      scopeKey,
      scope,
      workspacePath,
      resolve,
      webContents,
      conversationId,
      approval, signal, deadlineAt,
    });
    if (!pendingPermissionRequests.get(call.toolCallId)) return;
    try { webContents.send('chat:stream:permission-request', { streamId, call, deadlineAt }); }
    catch { settlePermissionRequest(call.toolCallId, { granted: false, duration: 'denied' }, { reason: 'permission_unavailable', terminal: true }); }
  }

  function createFilePermissionRequester({ webContents, streamId, toolCallId, conversationId = null, permissionPolicy = null, sourceArguments = undefined, signal = null }) {
    return ({ tool, args, filePath, workspacePath }) => new Promise((resolvePermission) => {
      const call = buildFilePermissionCall({ tool, args, filePath, workspacePath, toolCallId });
      const policyDecision = automationCapabilityDecision(permissionPolicy, call);
      if (policyDecision) {
        resolvePermission(policyDecision);
        return;
      }
      const scopeKey = scopeKeyFor({ streamId, conversationId, workspacePath, call });
      const scopedGrant = approvedPermissionScopes.get(scopeKey);
      if (scopedGrant?.granted && scopedGrant.expiresAt > Number(now())) {
        resolvePermission({
          granted: true,
          grant: createAutoScopeGrant({ toolCallId: call.toolCallId, scope: scopedGrant.scope || call.capabilityId }),
          reason: 'local_user_approved_scope',
        });
        return;
      }
      const accessGrant = maybeCreateAutoGrantForFile({ accessLevel, call });
      if (accessGrant) {
        resolvePermission(accessGrant);
        return;
      }
      const sourceGrant = reuseApprovedSourceToolCall(call, { streamId, conversationId, workspacePath, sourceArguments });
      if (sourceGrant) {
        resolvePermission(sourceGrant);
        return;
      }
      askUser({
        webContents,
        streamId,
        call,
        scopeKey,
        scope: call.capabilityId,
        resolve: resolvePermission,
        signal,
        conversationId,
        workspacePath,
      });
    });
  }

  function createLocalCapabilityPermissionRequester({ webContents, streamId, toolCallId, conversationId = null, workspacePath = null, permissionPolicy = null, sourceArguments = undefined, signal = null }) {
    return (request = {}) => new Promise((resolvePermission) => {
      const call = buildLocalCapabilityPermissionCall({ request, toolCallId });
      const policyDecision = automationCapabilityDecision(permissionPolicy, call);
      if (policyDecision) {
        resolvePermission(policyDecision);
        return;
      }
      if (call.capabilityId === 'local.image.read') {
        const inherited = imageAuthority.match({ principal: principalFor({ streamId, conversationId, workspacePath }),
          scope: request.scope, toolCallId: call.toolCallId });
        if (inherited) { resolvePermission({ ...inherited, validate: () => Boolean(imageAuthority.match({
          principal: principalFor({ streamId, conversationId, workspacePath }), scope: request.scope, toolCallId: call.toolCallId })) }); return; }
      }
      const scopeKey = scopeKeyFor({ streamId, conversationId, workspacePath, call });
      const scopedGrant = approvedPermissionScopes.get(scopeKey);
      if (scopedGrant?.granted && scopedGrant.expiresAt > Number(now())) {
        resolvePermission({
          granted: true,
          grant: createAutoScopeGrant({ toolCallId: call.toolCallId, scope: scopedGrant.scope || call.capabilityId }),
          reason: 'local_user_approved_scope',
        });
        return;
      }
      const profile = activeStreams.get(streamId)?.turnProfile;
      if (accessLevel === 'full_local' && profile?.role !== 'project_agent' && profile?.agentKind !== 'verifier') {
        resolvePermission(createAutoAccessGrant({
          toolCallId: call.toolCallId,
          scope: call.capabilityId,
          reason: 'local_access_level_full',
        }));
        return;
      }
      const sourceGrant = reuseApprovedSourceToolCall(call, { streamId, conversationId, workspacePath, sourceArguments });
      if (sourceGrant) {
        resolvePermission(sourceGrant);
        return;
      }
      askUser({
        webContents,
        streamId,
        call,
        scopeKey,
        scope: call.capabilityId,
        resolve: resolvePermission,
        signal,
        conversationId,
        workspacePath,
      });
    });
  }

  function createShellApprovalDecider({
    webContents,
    streamId,
    toolCallId,
    conversationId = null,
    workspacePath = null,
    permissionPolicy = null,
    sourceArguments = undefined,
    signal = null,
  }) {
    return ({ call, classification, ruleDecision }) => new Promise((resolvePermission) => {
      const permissionCall = buildShellPermissionCall({ call, classification, ruleDecision, toolCallId });
      if(permissionPolicy?.kind==='objective_probe'){resolvePermission(createPolicyDenial({toolCallId:permissionCall.toolCallId,reason:'objective_probe_read_only'}));return;}
      if (permissionPolicy?.kind === 'automation') {
        if (compareShellRisk(classification?.riskLevel, 'L4_privileged') >= 0) {
          resolvePermission(createPolicyDenial({
            toolCallId: permissionCall.toolCallId,
            reason: 'automation_high_risk_blocked',
          }));
          return;
        }
        const policyDecision = automationCapabilityDecision(permissionPolicy, permissionCall);
        if (policyDecision) {
          resolvePermission(policyDecision);
          return;
        }
      }
      const scopeKey = scopeKeyFor({
        streamId, conversationId,
        workspacePath: workspacePath || classification.cwd,
        call: permissionCall,
      });
      const scopedGrant = approvedPermissionScopes.get(scopeKey);
      if (scopedGrant?.granted && scopedGrant.expiresAt > Number(now())) {
        resolvePermission({
          granted: true,
          grant: createAutoScopeGrant({
            toolCallId: permissionCall.toolCallId,
            scope: scopedGrant.scope || permissionCall.capabilityId,
          }),
          reason: 'local_user_approved_scope',
        });
        return;
      }
      const accessGrant = maybeCreateAutoGrantForShell({ accessLevel, permissionCall, classification });
      if (accessGrant) {
        resolvePermission(accessGrant);
        return;
      }
      const sourceGrant = reuseApprovedSourceToolCall(permissionCall, { streamId, conversationId, workspacePath: workspacePath || classification.cwd, sourceArguments });
      if (sourceGrant) {
        resolvePermission(sourceGrant);
        return;
      }
      askUser({
        webContents,
        streamId,
        call: permissionCall,
        scopeKey,
        scope: permissionCall.capabilityId,
        resolve: resolvePermission,
        signal,
        conversationId,
        workspacePath: workspacePath || classification.cwd,
      });
    });
  }

  function settlePermissionRequest(toolCallId, grant, options = {}) {
    const pending = pendingPermissionRequests.take(toolCallId, options.terminal === true);
    if (!pending) return false;
    activeStreams.get(pending.streamId)?.permissionIds?.delete(toolCallId);
    let endingReason = options.reason ?? (grant?.reason && grant.granted !== true ? 'permission_cancelled' : null);
    if (endingReason) grant = { ...grant, granted: false, duration: 'denied' };
    const rememberType = options.remember === false
      ? false
      : Boolean(grant?.granted && ['scope', 'session', 'task', 'persistent'].includes(grant.duration) && pending.reusable && pending.scopeKey);
    if (rememberType) {
      approvedPermissionScopes.set(pending.scopeKey, {
        ...grant,
        scope: grant.scope || pending.scope,
        expiresAt: Number(now()) + 30 * 60 * 1000,
      });
    }
    if (grant?.granted) {
      const sourceId = sourceToolCallIdFromPermissionId(toolCallId);
      if (sourceId) approvedSourceToolCalls.set(sourceId, { grant, confirmation: pending.call.argumentsPreview?.kind === 'goal-confirmation',
        key: scopeKeyFor({ streamId: pending.streamId, conversationId: pending.conversationId, workspacePath: pending.workspacePath,
          call: { ...pending.call, capabilityId: pending.call.argumentsPreview?.authorizedCapabilityId ?? pending.call.capabilityId } }),
        expiresAt: Number(now()) + 30 * 60 * 1000 });
    }
    if (rememberType && pending.call.capabilityId === 'local.image.read') {
      // Generic argument cache cannot substitute for live file / family checks.
      approvedPermissionScopes.delete(pending.scopeKey);
      try {
        const record = recordApproval({ call: pending.call, streamId: pending.streamId,
          conversationId: pending.conversationId, workspacePath: pending.workspacePath, state: 'approved', decidedBy: 'local_ui',
          deadlineAt: pending.deadlineAt, createdAt: pending.approval?.createdAt });
        const imageGrant = imageAuthority.remember({ principal: principalFor(pending), scope: pending.call.argumentsPreview, record });
        if (!imageGrant) { grant = { ...grant, granted: false, duration: 'denied' }; }
        else grant = { ...grant, grantId: imageGrant.grantId, scope: imageGrant.scope };
      } catch { grant = { ...grant, granted: false, duration: 'denied' }; }
      if (!grant.granted) approvedSourceToolCalls.delete(sourceToolCallIdFromPermissionId(toolCallId));
    }
    const decisionPrincipal = principalFor(pending);
    const decisionEpoch = policyEpoch;
    const saved = recordApproval({
      call: pending.call,
      streamId: pending.streamId,
      conversationId: pending.approval?.conversationId ?? pending.conversationId,
      state: grant?.granted ? 'approved' : endingReason === 'permission_cancelled' ? 'cancelled' : endingReason ? 'expired' : 'denied',
      decidedBy: options.decidedBy ?? (endingReason ? 'policy' : 'local_ui'),
      deadlineAt: pending.deadlineAt,
      decisionReason: endingReason ?? (grant?.granted ? undefined : 'local_user_denied'),
      workspaceId: pending.approval?.workspaceId ?? null,
      planId: pending.approval?.planId ?? null,
      argsDigest: pending.approval?.argsDigest,
      createdAt: pending.approval?.createdAt,
    });
    if (durableApprovals && !saved && grant?.granted) {
      grant = { ...grant, granted: false, duration: 'denied' }; endingReason = 'permission_unavailable';
      approvedPermissionScopes.delete(pending.scopeKey); approvedSourceToolCalls.delete(sourceToolCallIdFromPermissionId(toolCallId));
    }
    pending.resolve({
      ...(pending.call.capabilityId === 'local.image.read' ? { validate: () => {
        if (policyEpoch !== decisionEpoch || !decisionPrincipal || digestApprovalArgs(principalFor(pending)) !== digestApprovalArgs(decisionPrincipal)) return false;
        return !rememberType || Boolean(imageAuthority.match({ principal: principalFor(pending), scope: pending.call.argumentsPreview, toolCallId }));
      } } : {}),
      granted: Boolean(grant?.granted),
      grant,
      reason: grant?.granted
        ? rememberType
          ? 'local_user_approved_scope'
          : 'local_user_approved_once'
        : endingReason ?? 'local_user_denied',
    });
    const settledEvent = { streamId: pending.streamId, toolCallIds: [toolCallId], granted: Boolean(grant?.granted),
      reason: endingReason ?? (grant?.granted ? 'local_user_approved_once' : 'local_user_denied') };
    // Bot sinks have no BrowserWindow. Broadcast alone cannot update their Activity.
    if (typeof notifySettled !== 'function' || activeStreams.get(pending.streamId)?.turnProfile?.role === 'project_agent') {
      try { pending.webContents?.send?.('chat:stream:permission-settled', settledEvent); } catch {}
    }
    try { notifySettled?.(pending.streamId, [toolCallId], settledEvent); } catch {}
    if (rememberType && grant?.granted && !options.cascaded) {
      for (const [pendingId, other] of [...pendingPermissionRequests.entries()]) {
        if (other.scopeKey !== pending.scopeKey) continue;
        settlePermissionRequest(pendingId, { ...grant, toolCallId: pendingId }, { cascaded: true });
      }
    }
    return true;
  }

  function listPendingPermissions({ streamId = null, conversationId = null } = {}) {
    const items = [];
    for (const [toolCallId, pending] of pendingPermissionRequests.entries()) {
      if (streamId && pending.streamId !== streamId) continue;
      if (conversationId && pending.conversationId !== conversationId) continue;
      items.push({ toolCallId, streamId: pending.streamId, call: pending.call });
    }
    return items;
  }

  function settleStreamPermissionRequests(streamId, grant) {
    const ids = [...pendingPermissionRequests.entries()].filter(([, pending]) => pending.streamId === streamId).map(([id]) => id);
    for (const id of ids) {
      settlePermissionRequest(id, grant, { reason: 'permission_cancelled', terminal: true });
    }
  }

  const gate = {
    configure,
    createFilePermissionRequester,
    createLocalCapabilityPermissionRequester,
    createShellApprovalDecider,
    listPendingPermissions,
    setAccessLevel,
    settlePermissionRequest,
    settleStreamPermissionRequests,
  };
  activeGate = gate;
  return gate;
}
