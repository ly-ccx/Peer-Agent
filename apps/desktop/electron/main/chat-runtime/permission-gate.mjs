import { randomUUID } from 'node:crypto';

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
  const sub = tokens.slice(1).find((token) => !token.startsWith('-'));
  return sub ? `${base} ${sub}` : base;
}

function buildPermissionSignature(call) {
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

export function createChatPermissionGate({ activeStreams, accessLevel: initialAccessLevel = 'ask_before_local' } = {}) {
  const pendingPermissionRequests = new Map();
  const approvedPermissionScopes = new Map();
  let accessLevel = normalizeLocalAccessLevel(initialAccessLevel);

  function setAccessLevel(nextAccessLevel) {
    accessLevel = normalizeLocalAccessLevel(nextAccessLevel);
    return accessLevel;
  }

  function registerPendingPermission({ streamId, call, scopeKey, scope, resolve }) {
    pendingPermissionRequests.set(call.toolCallId, {
      streamId,
      scopeKey,
      scope,
      resolve,
    });
    const active = activeStreams.get(streamId);
    if (active) {
      if (!active.permissionIds) active.permissionIds = new Set();
      active.permissionIds.add(call.toolCallId);
    }
  }

  function createFilePermissionRequester({ webContents, streamId, toolCallId, conversationId = null }) {
    return ({ tool, args, filePath, workspacePath }) => new Promise((resolvePermission) => {
      const call = buildFilePermissionCall({ tool, args, filePath, workspacePath, toolCallId });
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
      registerPendingPermission({
        streamId,
        call,
        scopeKey,
        scope: call.capabilityId,
        resolve: resolvePermission,
      });
      webContents.send('chat:stream:permission-request', { streamId, call });
    });
  }

  function createShellApprovalDecider({
    webContents,
    streamId,
    toolCallId,
    conversationId = null,
    workspacePath = null,
  }) {
    return ({ call, classification, ruleDecision }) => new Promise((resolvePermission) => {
      const permissionCall = buildShellPermissionCall({ call, classification, ruleDecision, toolCallId });
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
      registerPendingPermission({
        streamId,
        call: permissionCall,
        scopeKey,
        scope: permissionCall.capabilityId,
        resolve: resolvePermission,
      });
      webContents.send('chat:stream:permission-request', { streamId, call: permissionCall });
    });
  }

  function settlePermissionRequest(toolCallId, grant) {
    const pending = pendingPermissionRequests.get(toolCallId);
    if (!pending) return false;
    pendingPermissionRequests.delete(toolCallId);
    activeStreams.get(pending.streamId)?.permissionIds?.delete(toolCallId);
    if (grant?.granted && grant?.duration === 'scope' && pending.scopeKey) {
      approvedPermissionScopes.set(pending.scopeKey, {
        ...grant,
        scope: grant.scope || pending.scope,
      });
    }
    pending.resolve({
      granted: Boolean(grant?.granted),
      grant,
      reason: grant?.granted
        ? grant?.duration === 'scope'
          ? 'local_user_approved_scope'
          : 'local_user_approved_once'
        : 'local_user_denied',
    });
    return true;
  }

  function settleStreamPermissionRequests(streamId, grant) {
    const active = activeStreams.get(streamId);
    const ids = active?.permissionIds ? [...active.permissionIds] : [];
    for (const id of ids) {
      settlePermissionRequest(id, grant);
    }
  }

  return {
    createFilePermissionRequester,
    createShellApprovalDecider,
    setAccessLevel,
    settlePermissionRequest,
    settleStreamPermissionRequests,
  };
}
