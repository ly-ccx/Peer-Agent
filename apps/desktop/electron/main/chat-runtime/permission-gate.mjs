import { randomUUID } from 'node:crypto';
import { digestApprovalArgs } from '@peer-agent/runtime-node';

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
  const action = tool === 'edit_file' ? 'edit' : 'write';
  return {
    toolCallId: `chat-permission:${toolCallId || randomUUID()}`,
    capabilityId: `local.file.${action}`,
    displayName: tool,
    reason: `The ${tool} tool wants to modify a file outside the active workspace.`,
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
    riskLevel: 'L2_local_write',
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

function extractPermissionCommand(args) {
  if (!args || typeof args !== 'object') return '';
  const candidate =
    typeof args.command === 'string'
      ? args.command
      : typeof args.cmd === 'string'
        ? args.cmd
        : typeof args.script === 'string'
          ? args.script
          : '';
  return candidate.trim();
}

const LEAF_SHELL_COMMANDS = new Set([
  'awk',
  'bun',
  'cat',
  'chmod',
  'chown',
  'cp',
  'cut',
  'date',
  'echo',
  'env',
  'false',
  'find',
  'grep',
  'head',
  'hostname',
  'ls',
  'mkdir',
  'mv',
  'node',
  'perl',
  'printenv',
  'pwd',
  'python',
  'python3',
  'rg',
  'rm',
  'ruby',
  'sed',
  'sleep',
  'sort',
  'tail',
  'tee',
  'touch',
  'tr',
  'true',
  'uname',
  'uniq',
  'wc',
  'whoami',
  'xargs',
]);

function normalizePermissionCommandSignature(command) {
  const tokens = String(command || '').split(/\s+/).filter(Boolean);
  if (!tokens.length) return '';
  const base = tokens[0].split('/').pop() ?? tokens[0];
  if (
    (base === 'aone-kit' || base === 'a1') &&
    tokens[1] === 'call-tool' &&
    tokens[2]
  ) {
    return `${base} call-tool ${tokens[2]}`;
  }
  if (LEAF_SHELL_COMMANDS.has(base)) return base;
  const sub = tokens.slice(1).find((token) => !token.startsWith('-'));
  return sub ? `${base} ${sub}` : base;
}

function isReusablePermissionType(call) {
  const preview = call?.argumentsPreview;
  if (preview && typeof preview === 'object' && preview.kind === 'goal-confirmation') {
    return false;
  }
  if (call?.confirmation) return false;
  if (call?.capabilityId === 'local.file.edit' || call?.capabilityId === 'local.file.write') {
    return true;
  }
  return call?.capabilityId === 'local.shell.exec';
}

function buildPermissionSignature(call) {
  if (!isReusablePermissionType(call)) {
    return `${call.capabilityId}::once::${call.toolCallId}`;
  }
  if (call.capabilityId === 'local.file.edit' || call.capabilityId === 'local.file.write') {
    return call.capabilityId;
  }
  const command = extractPermissionCommand(call.argumentsPreview);
  if (!command) return call.capabilityId;
  return `${call.capabilityId}::${normalizePermissionCommandSignature(command)}`;
}

function buildPermissionScopeKey({ conversationId, workspacePath, call }) {
  const conversationScope = conversationId || 'no-conversation';
  const workspaceScope = workspacePath || 'no-workspace';
  return `${conversationScope}::${workspaceScope}::${buildPermissionSignature(call)}`;
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
  settleNotifier = null,
} = {}) {
  const pendingPermissionRequests = new Map();
  const approvedPermissionScopes = new Map();
  const approvedSourceToolCalls = new Map();
  let accessLevel = normalizeLocalAccessLevel(initialAccessLevel);
  let durableApprovals = approvalStore;
  let resolveScope = resolveApprovalScope;
  let notifySettled = settleNotifier;

  function configure(next = {}) {
    if (Object.prototype.hasOwnProperty.call(next, 'approvalStore')) durableApprovals = next.approvalStore;
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
      summary: previewSummary(call),
      riskLevel: call.riskLevel ?? null,
      argsDigest: argsDigest || digestApprovalArgs(call.arguments),
      createdAt: createdAt || call.requestedAt || new Date().toISOString(),
      state,
    };
    if (state !== 'open') {
      record.decidedAt = new Date().toISOString();
      record.decidedBy = decidedBy || 'local_ui';
    }
    try {
      return durableApprovals.append(record);
    } catch (error) {
      console.warn('[permission-gate] approval record failed:', error?.message || error);
      return null;
    }
  }

  function reuseApprovedSourceToolCall(call) {
    const sourceId = sourceToolCallIdFromPermissionId(call?.toolCallId);
    const remembered = sourceId ? approvedSourceToolCalls.get(sourceId) : null;
    if (!remembered?.grant?.granted) return null;
    return {
      granted: true,
      grant: {
        ...remembered.grant,
        toolCallId: call.toolCallId,
        duration: 'once',
      },
      reason: 'local_user_approved_same_tool_call',
    };
  }

  function setAccessLevel(nextAccessLevel) {
    accessLevel = normalizeLocalAccessLevel(nextAccessLevel);
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
  }) {
    pendingPermissionRequests.set(call.toolCallId, {
      streamId,
      call,
      conversationId,
      scopeKey,
      scope,
      resolve,
      webContents,
      reusable: isReusablePermissionType(call),
      approval,
    });
    const active = activeStreams.get(streamId);
    if (active) {
      if (!active.permissionIds) active.permissionIds = new Set();
      active.permissionIds.add(call.toolCallId);
    }
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
  }) {
    // Explorer / Verifier 没有审批人。询问会永远挂住，这里直接拒绝。
    // reason 会进入工具结果的 PermissionGrant / error，成为 Evidence 可见的拒绝原因。
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
    const approval = recordApproval({
      call,
      streamId,
      conversationId,
      workspacePath,
      state: 'open',
    });
    registerPendingPermission({
      streamId,
      call,
      scopeKey,
      scope,
      resolve,
      webContents,
      conversationId,
      approval,
    });
    webContents.send('chat:stream:permission-request', { streamId, call });
  }

  function createFilePermissionRequester({ webContents, streamId, toolCallId, conversationId = null, permissionPolicy = null }) {
    return ({ tool, args, filePath, workspacePath }) => new Promise((resolvePermission) => {
      const call = buildFilePermissionCall({ tool, args, filePath, workspacePath, toolCallId });
      const policyDecision = automationCapabilityDecision(permissionPolicy, call);
      if (policyDecision) {
        resolvePermission(policyDecision);
        return;
      }
      const scopeKey = buildPermissionScopeKey({ conversationId, workspacePath, call });
      const scopedGrant = approvedPermissionScopes.get(scopeKey);
      if (scopedGrant?.granted) {
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
      const sourceGrant = reuseApprovedSourceToolCall(call);
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
        conversationId,
        workspacePath,
      });
    });
  }

  function createLocalCapabilityPermissionRequester({ webContents, streamId, toolCallId, conversationId = null, workspacePath = null, permissionPolicy = null }) {
    return (request = {}) => new Promise((resolvePermission) => {
      const call = buildLocalCapabilityPermissionCall({ request, toolCallId });
      const policyDecision = automationCapabilityDecision(permissionPolicy, call);
      if (policyDecision) {
        resolvePermission(policyDecision);
        return;
      }
      const scopeKey = buildPermissionScopeKey({ conversationId, workspacePath, call });
      const scopedGrant = approvedPermissionScopes.get(scopeKey);
      if (scopedGrant?.granted) {
        resolvePermission({
          granted: true,
          grant: createAutoScopeGrant({ toolCallId: call.toolCallId, scope: scopedGrant.scope || call.capabilityId }),
          reason: 'local_user_approved_scope',
        });
        return;
      }
      if (accessLevel === 'full_local') {
        resolvePermission(createAutoAccessGrant({
          toolCallId: call.toolCallId,
          scope: call.capabilityId,
          reason: 'local_access_level_full',
        }));
        return;
      }
      const sourceGrant = reuseApprovedSourceToolCall(call);
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
  }) {
    return ({ call, classification, ruleDecision }) => new Promise((resolvePermission) => {
      const permissionCall = buildShellPermissionCall({ call, classification, ruleDecision, toolCallId });
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
      const scopeKey = buildPermissionScopeKey({
        conversationId,
        workspacePath: workspacePath || classification.cwd,
        call: permissionCall,
      });
      const scopedGrant = approvedPermissionScopes.get(scopeKey);
      if (scopedGrant?.granted) {
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
      const sourceGrant = reuseApprovedSourceToolCall(permissionCall);
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
        conversationId,
        workspacePath: workspacePath || classification.cwd,
      });
    });
  }

  function settlePermissionRequest(toolCallId, grant, options = {}) {
    const pending = pendingPermissionRequests.get(toolCallId);
    if (!pending) return false;
    pendingPermissionRequests.delete(toolCallId);
    activeStreams.get(pending.streamId)?.permissionIds?.delete(toolCallId);
    const rememberType = Boolean(grant?.granted && pending.reusable && pending.scopeKey);
    if (rememberType) {
      approvedPermissionScopes.set(pending.scopeKey, {
        ...grant,
        scope: grant.scope || pending.scope,
      });
    }
    if (grant?.granted) {
      const sourceId = sourceToolCallIdFromPermissionId(toolCallId);
      if (sourceId) approvedSourceToolCalls.set(sourceId, { grant });
    }
    pending.resolve({
      granted: Boolean(grant?.granted),
      grant,
      reason: grant?.granted
        ? rememberType
          ? 'local_user_approved_scope'
          : 'local_user_approved_once'
        : 'local_user_denied',
    });
    recordApproval({
      call: pending.call,
      streamId: pending.streamId,
      conversationId: pending.approval?.conversationId ?? pending.conversationId,
      state: grant?.granted ? 'approved' : 'denied',
      decidedBy: 'local_ui',
      workspaceId: pending.approval?.workspaceId ?? null,
      planId: pending.approval?.planId ?? null,
      argsDigest: pending.approval?.argsDigest,
      createdAt: pending.approval?.createdAt,
    });
    if (rememberType && !options.cascaded) {
      const cascadedIds = [];
      for (const [pendingId, other] of [...pendingPermissionRequests.entries()]) {
        if (other.scopeKey !== pending.scopeKey) continue;
        const cascadedGrant = {
          ...grant,
          toolCallId: pendingId,
        };
        settlePermissionRequest(pendingId, cascadedGrant, { cascaded: true });
        cascadedIds.push(pendingId);
      }
      const settledIds = [toolCallId, ...cascadedIds];
      if (typeof notifySettled === 'function') {
        notifySettled(pending.streamId, settledIds);
      } else if (cascadedIds.length) {
        pending.webContents?.send?.('chat:stream:permission-settled', {
          streamId: pending.streamId,
          toolCallIds: cascadedIds,
        });
      }
    } else if (!options.cascaded && typeof notifySettled === 'function') {
      notifySettled(pending.streamId, [toolCallId]);
    }
    return true;
  }

  function listPendingPermissions({ streamId = null, conversationId = null } = {}) {
    const items = [];
    for (const [toolCallId, pending] of pendingPermissionRequests) {
      if (streamId && pending.streamId !== streamId) continue;
      if (conversationId && pending.conversationId !== conversationId) continue;
      items.push({ toolCallId, streamId: pending.streamId, call: pending.call });
    }
    return items;
  }

  function settleStreamPermissionRequests(streamId, grant) {
    const active = activeStreams.get(streamId);
    const ids = active?.permissionIds ? [...active.permissionIds] : [];
    for (const id of ids) {
      settlePermissionRequest(id, grant);
    }
  }

  return {
    configure,
    createFilePermissionRequester,
    createLocalCapabilityPermissionRequester,
    createShellApprovalDecider,
    listPendingPermissions,
    setAccessLevel,
    settlePermissionRequest,
    settleStreamPermissionRequests,
  };
}
