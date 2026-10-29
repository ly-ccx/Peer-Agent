import type { DelegationEvent } from './delegation.ts';

export type ProjectRecoveryFailureKind = 'response_headers_timeout' | 'network' | 'stream_interrupted'
  | 'provider_transient' | 'rate_limited' | 'authentication' | 'invalid_request' | 'configuration'
  | 'permission' | 'budget_exhausted' | 'execution_outcome_unknown' | 'cancelled' | 'fatal';

/** Produced by the host request boundary; never inferred from assistant prose. */
export interface ProviderRequestRecovery {
  readonly kind: ProjectRecoveryFailureKind;
  readonly phase?: 'response_headers' | 'stream' | 'request';
  readonly requestId?: string;
  readonly attempts?: number;
  readonly maxAttempts?: number;
  readonly exhausted?: boolean;
  readonly replaySafe?: boolean;
  readonly retryable: boolean;
}

const RECOVERABLE = new Set<ProjectRecoveryFailureKind>(['response_headers_timeout', 'network', 'stream_interrupted', 'provider_transient', 'rate_limited']);
const FAILURE_KINDS = new Set<ProjectRecoveryFailureKind>([...RECOVERABLE, 'authentication', 'invalid_request', 'configuration', 'permission', 'budget_exhausted', 'execution_outcome_unknown', 'cancelled', 'fatal']);

/** Legacy diagnostics are admitted only at this seam; structured host failure takes precedence. */
export function classifyProjectAgentFailure(reason: unknown, detail?: unknown): { kind: ProjectRecoveryFailureKind; retryable: boolean } {
  if (detail && typeof detail === 'object' && 'kind' in detail && FAILURE_KINDS.has(detail.kind as ProjectRecoveryFailureKind)) {
    const kind = detail.kind as ProjectRecoveryFailureKind;
    return { kind, retryable: RECOVERABLE.has(kind) && !('retryable' in detail && detail.retryable === false) };
  }
  const code = typeof reason === 'string' ? reason.trim().replace(/^代理暂时不可用：\s*/, '') : '';
  let kind: ProjectRecoveryFailureKind = 'fatal';
  if (/^(agent_tool_budget_exhausted|agent_loop_exhausted|work_budget_limited)(?:\s*:|$)/.test(code)) kind = 'budget_exhausted';
  else if (/^(execution_outcome_unknown|checkpoint_persistence_failed)(?:\s*:|$)/.test(code)) kind = 'execution_outcome_unknown';
  else if (/^(work_execution_stopped|aborted|AbortError|user_stopped)(?:\s*:|$)/i.test(code)) kind = 'cancelled';
  else if (/^(permission_denied|permission_revoked|authorization_denied)(?:\s*:|$)/i.test(code)) kind = 'permission';
  else if (/^(connect timeout after|response_headers_timeout)|ConnectTimeoutError/.test(code)) kind = 'response_headers_timeout';
  else if (/^(provider_stream_idle_timeout|provider_stream_interrupted)(?:\s*:|$)/.test(code)) kind = 'stream_interrupted';
  else if (/^(HTTP\s*)?(401|403)(?:\s|:|$)|^(authentication_error|invalid_api_key|credential_unavailable)(?:\s*:|$)/i.test(code)) kind = 'authentication';
  else if (/^(HTTP\s*)?429(?:\s|:|$)/i.test(code)) kind = 'rate_limited';
  else if (/^(HTTP\s*)?(500|502|503|504)(?:\s|:|$)|^(server_error|server_is_overloaded)(?:\s*:|$)/i.test(code)) kind = 'provider_transient';
  else if (/^(HTTP\s*)?(400|404|422)(?:\s|:|$)|^(invalid_request|provider_checkpoint_mismatch)(?:\s*:|$)/i.test(code)) kind = 'invalid_request';
  else if (/^(CERT_|ERR_CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO_SELF_SIGNED_CERT|provider_not_configured|work_budget_host_unavailable)/i.test(code)) kind = 'configuration';
  else if (/^(fetch failed|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UND_ERR_(SOCKET|CONNECT_TIMEOUT)|(?:net::)?ERR_(CONNECTION|NETWORK|TIMED_OUT|NAME_NOT_RESOLVED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|INTERNET_DISCONNECTED))/i.test(code)) kind = 'network';
  return { kind, retryable: RECOVERABLE.has(kind) };
}

/** Host failure classification, including the persisted diagnostic prefix used by older cards. */
export function projectAgentFailureKind(reason: unknown): 'budget_exhausted' | 'unavailable' {
  if (typeof reason !== 'string') return 'unavailable';
  const code = reason.trim().replace(/^代理暂时不可用：\s*/, '');
  return /^(agent_tool_budget_exhausted|agent_loop_exhausted|work_budget_limited)(?:\s*:|$)/.test(code)
    ? 'budget_exhausted' : 'unavailable';
}

/** Durable host facts for an explicit retry; never a new user authorization. */
export interface ProjectAgentTurnRecovery {
  readonly events: readonly DelegationEvent[];
  readonly throughSeq: number;
}

/** Factual recovery data returned by post_reply after anchor validation fails. */
export interface ReplyAnchorCandidate {
  readonly messageId: string;
  readonly text: string;
}
