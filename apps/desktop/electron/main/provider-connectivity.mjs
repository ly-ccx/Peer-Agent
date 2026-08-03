// Provider 连通性判定与阶段化诊断的纯逻辑（无 electron / 无网络依赖，可独立单测）。
//
// 职责边界：
// - 这里只做"给定已解密的 token / 已推导的 oauth 状态 / 原始错误 → 结论"的纯映射。
// - 真正的解密(safeStorage)、落盘、远程探测留在 llm-config-store / provider-adapters。
// 这样存储层不必为了被测试而拉起 electron 运行时，也避免在多处散落订阅判定口径。

/**
 * 由已解密的订阅 token 推导对外可见的登录态（不泄漏 token 本身）。
 * @param {{ access?: string, expires?: number, accountId?: string } | null | undefined} tokens
 * @param {number} now 当前时间戳(ms)，便于测试注入
 * @returns {{ status: 'connected' | 'expired' | 'disconnected', accountId?: string, expiresAt?: string }}
 */
export function deriveOAuthStatus(tokens, now = Date.now()) {
  if (!tokens?.access) return { status: 'disconnected' };
  const expiresAt =
    typeof tokens.expires === 'number' ? new Date(tokens.expires).toISOString() : undefined;
  const status =
    typeof tokens.expires === 'number' && tokens.expires <= now ? 'expired' : 'connected';
  return { status, accountId: tokens.accountId, expiresAt };
}

/**
 * 订阅类 provider 的连通性测试结果。
 * 成功时返回 { success:true, model, latencyMs:0 }；
 * 失败时返回 { success:false, error, errorCategory, stages, connectionState }。
 */
export function resolveSubscriptionTestResult(oauthStatus, model) {
  const startedAt = new Date().toISOString();
  if (oauthStatus?.status === 'connected') {
    const stages = [
      stage('config', 'passed', '配置完整'),
      stage('connectivity', 'passed', '授权通道可用'),
      stage('auth', 'passed', '登录有效'),
      stage('catalog', 'skipped', '订阅模型目录由内置清单提供'),
      stage('min_inference', 'skipped', '订阅登录不在此步发起计费推理'),
    ];
    return withDiagnostic({
      success: true,
      model,
      latencyMs: 0,
      stages,
      connectionState: 'available',
      connectionStateReason: '授权登录有效',
      startedAt,
    });
  }

  const expired = oauthStatus?.status === 'expired';
  const stages = [
    stage('config', 'passed', '配置完整'),
    stage('connectivity', expired ? 'passed' : 'failed', expired ? '服务可达' : '未登录'),
    stage(
      'auth',
      'failed',
      expired ? '登录会话已过期' : '尚未完成授权登录',
    ),
    stage('catalog', 'skipped', '认证失败，未检查模型目录'),
    stage('min_inference', 'skipped', '认证失败，未发起最小请求'),
  ];
  return withDiagnostic({
    success: false,
    error: expired ? 'oauth_session_expired' : 'oauth_not_logged_in',
    errorCategory: expired ? 'auth_expired' : 'credential_missing',
    stages,
    connectionState: 'needs_attention',
    connectionStateReason: expired ? '登录已过期，请重新登录' : '尚未完成授权登录',
    startedAt,
  });
}

/**
 * 将原始错误映射为用户可见错误分类。
 * @param {string | null | undefined} error
 * @param {{ authMethod?: string }} [context]
 */
export function classifyProviderError(error, context = {}) {
  const text = String(error || '').toLowerCase();
  if (!text) return 'unknown';

  if (
    text.includes('api key not configured')
    || text.includes('oauth_not_logged_in')
    || text.includes('missing')
  ) {
    return 'credential_missing';
  }
  if (
    text.includes('oauth_session_expired')
    || text.includes('expired')
    || text.includes('token expired')
  ) {
    return 'auth_expired';
  }
  if (
    text.includes('401')
    || text.includes('unauthorized')
    || text.includes('invalid api key')
    || text.includes('invalid_api_key')
    || text.includes('authentication')
  ) {
    return 'credential_invalid';
  }
  if (
    text.includes('403')
    || text.includes('permission')
    || text.includes('forbidden')
  ) {
    return 'permission_denied';
  }
  if (
    text.includes('404')
    || text.includes('model_not_found')
    || text.includes('model not found')
    || text.includes('does not exist')
  ) {
    return 'model_not_found';
  }
  if (
    text.includes('429')
    || text.includes('rate limit')
    || text.includes('too many requests')
  ) {
    return 'rate_limited';
  }
  if (
    text.includes('quota')
    || text.includes('insufficient_quota')
    || text.includes('billing')
    || text.includes('balance')
  ) {
    return 'quota_exhausted';
  }
  if (
    text.includes('econnrefused')
    || text.includes('enotfound')
    || text.includes('econnreset')
    || text.includes('fetch failed')
    || text.includes('network')
    || text.includes('socket')
  ) {
    if (context.authMethod === 'qoder_local_auth' || context.authMethod === 'local_cli') {
      return 'local_runtime_stopped';
    }
    return 'endpoint_unreachable';
  }
  if (text.includes('timeout') || text.includes('etimedout') || text.includes('aborted')) {
    return 'timeout';
  }
  if (
    text.includes('unsupported_wire')
    || text.includes('invalid json')
    || text.includes('unexpected token')
    || text.includes('protocol')
  ) {
    return 'protocol_mismatch';
  }
  return 'unknown';
}

/**
 * 根据错误分类给出连接状态建议。
 * @param {string} errorCategory
 */
export function connectionStateForErrorCategory(errorCategory) {
  switch (errorCategory) {
    case 'credential_missing':
    case 'credential_invalid':
    case 'auth_expired':
    case 'quota_exhausted':
    case 'permission_denied':
    case 'local_runtime_stopped':
      return 'needs_attention';
    case 'model_not_found':
    case 'capability_mismatch':
      return 'partial';
    case 'endpoint_unreachable':
    case 'timeout':
    case 'protocol_mismatch':
    case 'rate_limited':
    case 'unknown':
    default:
      return 'unavailable';
  }
}

/**
 * 为 API Key / 兼容服务测试结果补充阶段化诊断字段。
 * 在不改变原有 success/error/latencyMs 语义的前提下扩展。
 * @param {{ success: boolean, model?: string, latencyMs?: number, error?: string }} result
 * @param {{ authMethod?: string, hasApiKey?: boolean, baseUrl?: string, connectionId?: string, configVersion?: number, trigger?: string }} [context]
 */
export function enrichTestResultWithDiagnostics(result, context = {}) {
  const startedAt = new Date().toISOString();
  if (result?.success) {
    const stages = [
      stage('config', 'passed', '配置完整'),
      stage('connectivity', 'passed', '服务可达'),
      stage('auth', 'passed', '凭据有效'),
      stage('catalog', 'skipped', '模型目录由同步流程单独验证'),
      stage('min_inference', 'passed', '最小请求成功', result.latencyMs),
    ];
    return withDiagnostic({
      ...result,
      stages,
      connectionState: 'available',
      connectionStateReason: '连接测试成功',
      startedAt,
      connectionId: context.connectionId,
      configVersion: context.configVersion,
      trigger: context.trigger,
    });
  }

  const errorCategory = classifyProviderError(result?.error, context);
  const connectionState = connectionStateForErrorCategory(errorCategory);
  const authFailed = [
    'credential_missing',
    'credential_invalid',
    'auth_expired',
    'permission_denied',
  ].includes(errorCategory);
  const connectivityFailed = [
    'endpoint_unreachable',
    'timeout',
    'local_runtime_stopped',
  ].includes(errorCategory);

  const stages = [
    stage(
      'config',
      context.hasApiKey === false && errorCategory === 'credential_missing' ? 'failed' : 'passed',
      context.hasApiKey === false ? '缺少凭据' : '配置字段可提交',
    ),
    stage(
      'connectivity',
      connectivityFailed ? 'failed' : authFailed ? 'passed' : 'failed',
      connectivityFailed ? '无法连接服务' : '网络阶段未单独失败',
    ),
    stage(
      'auth',
      authFailed ? 'failed' : connectivityFailed ? 'skipped' : 'failed',
      authFailed ? '凭据或登录无效' : connectivityFailed ? '网络失败，未检查认证' : '请求被拒绝',
    ),
    stage(
      'catalog',
      errorCategory === 'model_not_found' ? 'failed' : 'skipped',
      errorCategory === 'model_not_found' ? '模型不存在或不可用' : '未单独检查模型目录',
    ),
    stage(
      'min_inference',
      'failed',
      String(result?.error || '连接失败').slice(0, 200),
      result?.latencyMs,
    ),
  ];

  return withDiagnostic({
    ...result,
    errorCategory,
    stages,
    connectionState,
    connectionStateReason: reasonForErrorCategory(errorCategory),
    startedAt,
    connectionId: context.connectionId,
    configVersion: context.configVersion,
    trigger: context.trigger,
  });
}

function stage(id, status, title, durationMs) {
  return {
    id,
    status,
    title,
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
  };
}

function reasonForErrorCategory(errorCategory) {
  switch (errorCategory) {
    case 'credential_missing':
      return '缺少登录凭据';
    case 'credential_invalid':
      return '凭据无效';
    case 'auth_expired':
      return '登录已过期';
    case 'endpoint_unreachable':
      return '无法连接服务';
    case 'rate_limited':
      return '请求过于频繁';
    case 'quota_exhausted':
      return '额度已用完';
    case 'permission_denied':
      return '没有模型权限';
    case 'model_not_found':
      return '模型不存在';
    case 'protocol_mismatch':
      return '服务响应不兼容';
    case 'local_runtime_stopped':
      return '本地服务未运行';
    case 'timeout':
      return '服务响应超时';
    default:
      return '连接失败';
  }
}

function withDiagnostic(payload) {
  const finishedAt = new Date().toISOString();
  const diagnostic = {
    connectionId: payload.connectionId,
    configVersion: payload.configVersion,
    startedAt: payload.startedAt || finishedAt,
    finishedAt,
    trigger: payload.trigger || 'user',
    stages: payload.stages || [],
    errorCategory: payload.errorCategory,
    sanitizedDetail: payload.error ? sanitizeDiagnosticDetail(payload.error) : undefined,
    suggestedActions: suggestedActionsFor(payload.errorCategory, payload.connectionState),
  };

  const {
    startedAt: _startedAt,
    connectionId: _connectionId,
    configVersion: _configVersion,
    trigger: _trigger,
    ...rest
  } = payload;

  return {
    ...rest,
    diagnostic,
  };
}

function suggestedActionsFor(errorCategory, connectionState) {
  switch (errorCategory) {
    case 'credential_missing':
      return ['添加凭据', '或选择授权登录'];
    case 'credential_invalid':
      return ['更新 API Key', '复制诊断信息'];
    case 'auth_expired':
      return ['重新登录'];
    case 'endpoint_unreachable':
      return ['重新测试', '检查 API 地址或网络'];
    case 'rate_limited':
      return ['稍后重试'];
    case 'quota_exhausted':
      return ['查看服务商额度', '更换模型'];
    case 'permission_denied':
      return ['选择其他模型', '检查账号权限'];
    case 'model_not_found':
      return ['同步模型', '手动添加模型 ID'];
    case 'local_runtime_stopped':
      return ['启动本地服务', '重新检测'];
    case 'timeout':
      return ['重试', '检查网络'];
    default:
      return connectionState === 'needs_attention' ? ['立即修复'] : ['重新测试', '复制诊断信息'];
  }
}

/**
 * 诊断复制用的最小脱敏：去掉明显的 Bearer / sk- 片段。
 * @param {string} detail
 */
export function sanitizeDiagnosticDetail(detail) {
  return String(detail || '')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-***')
    .replace(/ya29\.[A-Za-z0-9._\-]+/g, 'ya29.***')
    .slice(0, 500);
}
