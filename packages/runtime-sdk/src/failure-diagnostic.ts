import type { RuntimeFailureDiagnostic } from './contracts.ts';
export function failureDiagnostic(error: unknown): RuntimeFailureDiagnostic | undefined {
  if (!error || typeof error !== 'object' || !('diagnostic' in error))
    return undefined;
  const value = error.diagnostic as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || typeof value.code !== 'string'
    || !/^(?:http_error|domain_blocked|context_(?:length|window)_exceeded|model_not_found|invalid_api_key|authentication_error|rate_limit_exceeded|insufficient_quota|invalid_request_error|configuration_error|server_error|peer_[a-z_]{1,64})$/.test(value.code)
    || !['provider', 'gateway_validation', 'host'].includes(String(value.source)))
    return undefined;
  const result: Record<string, unknown> = { code: value.code, source: value.source };
  if (Number.isInteger(value.status) && Number(value.status) >= 100 && Number(value.status) <= 599)
    result.status = value.status;
  if (Number.isInteger(value.upstreamStatus) && Number(value.upstreamStatus) >= 100 && Number(value.upstreamStatus) <= 599)
    result.upstreamStatus = value.upstreamStatus;
  for (const key of ['actual', 'limit'])
    if (Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
      result[key] = value[key];
  if (value.upstreamAttempted === false)
    result.upstreamAttempted = false;
  if (typeof value.requestId === 'string' && /^(?:[a-f0-9-]{8,64}|req_[a-zA-Z0-9]{1,64})$/.test(value.requestId))
    result.requestId = value.requestId;
  return result as unknown as RuntimeFailureDiagnostic;
}
