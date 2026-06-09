import type { ClientSessionState } from '@peer-agent/protocol';

export function sessionStatusKey(status: ClientSessionState['status']) {
  const keys = {
    local_ready: 'session.local_ready',
    hybrid_ready: 'session.hybrid_ready',
    permission_required: 'session.permission_required',
    degraded: 'session.degraded',
    offline: 'session.offline',
  } as const;

  return keys[status];
}
