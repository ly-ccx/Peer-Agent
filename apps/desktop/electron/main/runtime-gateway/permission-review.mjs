import { mergePermissionDecisions } from '@peer-agent/runtime-core';
import { createShellPermissionRuleStore } from './shell-permission-rules.mjs';
import { compareRisk, normalizeShellCwd, SHELL_RISK_ORDER } from './shell-classifier.mjs';

const ALLOWED_BEHAVIORS = new Set(['allow', 'ask', 'deny']);
const ALLOWED_MATCH_TYPES = new Set(['exact', 'prefix', 'wildcard']);
const ALLOWED_RISK_LEVELS = new Set(Object.keys(SHELL_RISK_ORDER));

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid shell permission rule: ${field} is required.`);
  }
  return value.trim();
}

function sanitizeMatch(match, behavior) {
  if (!match || typeof match !== 'object' || !ALLOWED_MATCH_TYPES.has(match.type)) {
    throw new Error('Invalid shell permission rule: match.type is required.');
  }
  if (behavior === 'allow' && match.type === 'wildcard') {
    throw new Error('Invalid shell permission rule: allow rules cannot use wildcard matches.');
  }
  if (match.type === 'exact') {
    return { type: 'exact', command: requireString(match.command, 'match.command') };
  }
  if (match.type === 'prefix') {
    const prefix = requireString(match.prefix, 'match.prefix');
    if (prefix.length < 4) {
      throw new Error('Invalid shell permission rule: match.prefix is too broad.');
    }
    return { type: 'prefix', prefix };
  }
  return { type: 'wildcard', pattern: requireString(match.pattern, 'match.pattern') };
}

function sanitizeScope(scope, behavior, workspaceRoot) {
  const nextScope = scope && typeof scope === 'object' ? { ...scope } : {};
  if (nextScope.cwd) {
    nextScope.cwd = normalizeShellCwd(nextScope.cwd, workspaceRoot);
  }
  if (nextScope.maxRiskLevel && !ALLOWED_RISK_LEVELS.has(nextScope.maxRiskLevel)) {
    throw new Error('Invalid shell permission rule: maxRiskLevel is unknown.');
  }
  if (nextScope.maxRiskLevel && compareRisk(nextScope.maxRiskLevel, 'L5_destructive') >= 0) {
    throw new Error('Invalid shell permission rule: maxRiskLevel cannot include destructive commands.');
  }
  if (behavior === 'allow') {
    if (!nextScope.cwd) {
      throw new Error('Invalid shell permission rule: allow rules must be scoped to a workspace cwd.');
    }
    if (!nextScope.maxRiskLevel) {
      throw new Error('Invalid shell permission rule: allow rules must declare maxRiskLevel.');
    }
  }
  return nextScope;
}

function sanitizeExpiresAt(expiresAt) {
  if (expiresAt === undefined || expiresAt === null || expiresAt === '') return undefined;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error('Invalid shell permission rule: expiresAt must be an ISO timestamp.');
  }
  return new Date(timestamp).toISOString();
}

function sanitizeShellRule(rule, { workspaceRoot }) {
  const behavior = ALLOWED_BEHAVIORS.has(rule?.behavior) ? rule.behavior : null;
  if (!behavior) {
    throw new Error('Invalid shell permission rule: behavior must be allow, ask, or deny.');
  }
  return {
    behavior,
    match: sanitizeMatch(rule?.match, behavior),
    scope: sanitizeScope(rule?.scope, behavior, workspaceRoot),
    expiresAt: sanitizeExpiresAt(rule?.expiresAt),
  };
}

function toPermissionDecision(decision, source, fallbackReason) {
  if (!decision?.behavior) return null;
  return {
    decision: decision.behavior,
    source,
    reason: decision.reason || fallbackReason,
  };
}

function hookFallbackReason(hookDecision) {
  if (hookDecision?.behavior === 'deny') return 'hook_denied';
  if (hookDecision?.behavior === 'ask') return 'hook_approval_required';
  return undefined;
}

function mergeHookDecision(ruleDecision, hookDecision) {
  if (!hookDecision?.behavior) return ruleDecision;
  const mergedDecision = mergePermissionDecisions([
    toPermissionDecision(ruleDecision, 'shell_rule'),
    toPermissionDecision(hookDecision, 'shell_hook', hookFallbackReason(hookDecision)),
  ]);
  if (mergedDecision.decision === 'deny' || mergedDecision.decision === 'ask') {
    return {
      ...ruleDecision,
      hookDecision,
      behavior: mergedDecision.decision,
      granted: false,
      reason: mergedDecision.reason,
    };
  }
  return {
    ...ruleDecision,
    hookDecision,
  };
}

async function resolveShellDecision({ call, classification, ruleStore, approvalDecider, localApproval, hookDecision }) {
  const ruleDecision = mergeHookDecision(ruleStore.decide(classification), hookDecision);
  if (ruleDecision.behavior === 'allow' || ruleDecision.behavior === 'deny') {
    return ruleDecision;
  }
  if (localApproval?.granted) {
    return {
      ...ruleDecision,
      behavior: 'allow',
      granted: true,
      reason: localApproval.reason || 'local_user_approved_once',
    };
  }
  if (!approvalDecider) {
    return {
      ...ruleDecision,
      granted: false,
      reason: ruleDecision.reason || 'local_user_approval_required',
    };
  }
  const approval = await approvalDecider({ call, classification, ruleDecision });
  return {
    ...ruleDecision,
    ...approval,
    behavior: approval?.granted ? 'allow' : 'deny',
    granted: Boolean(approval?.granted),
    reason: approval?.reason || ruleDecision.reason,
  };
}

export function createPermissionReview({
  userDataPath,
  workspaceRoot,
  shellRuleStore = createShellPermissionRuleStore({ userDataPath }),
  approvalDecider,
} = {}) {
  async function decideShellExecution({ call, classification, localApproval, hookDecision }) {
    return resolveShellDecision({
      call,
      classification,
      ruleStore: shellRuleStore,
      approvalDecider,
      localApproval,
      hookDecision,
    });
  }

  function addShellRule(rule) {
    return shellRuleStore.addRule(sanitizeShellRule(rule, { workspaceRoot }));
  }

  return {
    decideShellExecution,
    listShellRules: shellRuleStore.listRules,
    addShellRule,
    shellRuleStore,
  };
}
