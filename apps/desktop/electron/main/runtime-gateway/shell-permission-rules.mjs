import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compareRisk } from './shell-classifier.mjs';

const RULES_VERSION = 1;

function rulesPath(userDataPath) {
  return path.join(userDataPath, 'permissions', 'shell-rules.json');
}

function wildcardToRegExp(pattern) {
  const escaped = String(pattern || '*')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function normalizeRule(raw, index) {
  const behavior = ['allow', 'ask', 'deny'].includes(raw?.behavior) ? raw.behavior : 'ask';
  const match = raw?.match && typeof raw.match === 'object' ? raw.match : { type: 'wildcard', pattern: '*' };
  return {
    id: String(raw?.id || `shell-rule-${index}`),
    behavior,
    match,
    scope: raw?.scope && typeof raw.scope === 'object' ? raw.scope : {},
    expiresAt: raw?.expiresAt,
  };
}

function isExpired(rule, now = Date.now()) {
  return rule.expiresAt ? Date.parse(rule.expiresAt) <= now : false;
}

function matchesRule(rule, classification) {
  if (isExpired(rule)) return false;
  if (rule.scope?.maxRiskLevel && compareRisk(classification.riskLevel, rule.scope.maxRiskLevel) > 0) {
    return false;
  }
  if (rule.scope?.cwd) {
    const relative = path.relative(path.resolve(rule.scope.cwd), classification.cwd);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  }

  const command = classification.command;
  if (rule.match.type === 'exact') return command === rule.match.command;
  if (rule.match.type === 'prefix') return command === rule.match.prefix || command.startsWith(`${rule.match.prefix} `);
  if (rule.match.type === 'wildcard') return wildcardToRegExp(rule.match.pattern).test(command);
  return false;
}

function loadRules(filePath) {
  if (!existsSync(filePath)) {
    return {
      version: RULES_VERSION,
      rules: [],
    };
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  return {
    version: parsed?.version ?? RULES_VERSION,
    rules: Array.isArray(parsed?.rules) ? parsed.rules.map(normalizeRule) : [],
  };
}

function writeRules(filePath, state) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function decision({ behavior, reason, ruleId, classification }) {
  return {
    behavior,
    granted: behavior === 'allow',
    reason,
    ruleId,
    riskLevel: classification.riskLevel,
    category: classification.category,
  };
}

function defaultDecision(classification, env) {
  if (!classification.allowed) {
    return decision({ behavior: 'deny', reason: classification.reason, classification });
  }
  if (classification.category === 'read-only') {
    return decision({ behavior: 'allow', reason: 'read_only_auto_allowed', classification });
  }
  if (env.PEER_AGENT_SHELL_TRUST_WORKSPACE === '1' && compareRisk(classification.riskLevel, 'L4_privileged') <= 0) {
    return decision({ behavior: 'allow', reason: 'workspace_shell_trusted_by_environment', classification });
  }
  // destructive / unknown / privileged 都走 ask —— 由上层 approvalDecider 决定
  // （dev 模式注入 auto-allow，生产模式 UI 弹窗，未注入则 permission-review 兜底 deny）。
  // 不再"destructive_command_denied_by_default" 一刀切，那条规则跳过了 approvalDecider，
  // 让 dev 模式调试本地工具变成不可能（写文件 / 改文件等命令 100% 被默认 deny 卡死）。
  return decision({ behavior: 'ask', reason: 'local_user_approval_required', classification });
}

export function createShellPermissionRuleStore({ userDataPath, env = process.env } = {}) {
  const filePath = rulesPath(userDataPath);
  let state = loadRules(filePath);

  function listRules() {
    state = loadRules(filePath);
    return state.rules;
  }

  function saveRules(rules) {
    state = {
      version: RULES_VERSION,
      rules: rules.map(normalizeRule),
    };
    writeRules(filePath, state);
    return state.rules;
  }

  function addRule(rule) {
    const nextRule = normalizeRule({ ...rule, id: rule.id || randomUUID() }, state.rules.length);
    return saveRules([...state.rules, nextRule]);
  }

  function decide(classification) {
    state = loadRules(filePath);
    const matched = state.rules.filter((rule) => matchesRule(rule, classification));
    const deny = matched.find((rule) => rule.behavior === 'deny');
    if (deny) return decision({ behavior: 'deny', reason: 'matched_shell_deny_rule', ruleId: deny.id, classification });
    const ask = matched.find((rule) => rule.behavior === 'ask');
    if (ask) return decision({ behavior: 'ask', reason: 'matched_shell_ask_rule', ruleId: ask.id, classification });
    const allow = matched.find((rule) => rule.behavior === 'allow');
    if (allow && classification.category !== 'destructive') {
      return decision({ behavior: 'allow', reason: 'matched_shell_allow_rule', ruleId: allow.id, classification });
    }
    return defaultDecision(classification, env);
  }

  return {
    filePath,
    listRules,
    saveRules,
    addRule,
    decide,
  };
}
