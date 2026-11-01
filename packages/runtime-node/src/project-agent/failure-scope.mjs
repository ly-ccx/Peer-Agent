import { classifyProjectAgentFailure } from '@peer-agent/protocol';

const providerFailures = new Set(['response_headers_timeout', 'network', 'stream_interrupted', 'provider_transient', 'rate_limited', 'authentication', 'configuration']);
/** Journal/lease faults stop host dispatch; an individual semantic failure cannot trip Provider health. */
export function isHostCoordinationFailure(error) {
  const code = String(error?.code || error?.message || error || '');
  return /^(coordination_|unknown_coordination_event|intent_(executor|event|revision|closure|review|work)_|SQLITE_|ERR_SQLITE|EIO$|ENOSPC$|EROFS$|EACCES$)/.test(code);
}
export function projectFailureScope(reason, detail) {
  if (isHostCoordinationFailure(detail?.code || reason)) return 'host';
  return providerFailures.has(classifyProjectAgentFailure(reason, detail).kind) ? 'provider' : 'work';
}
