import type { I18nRuntime } from '@zeus-atlas/i18n';
import type { AuthState, ClientSessionState, CloudRuntimeState } from '@zeus-atlas/protocol';

export function cloudStatusKey(status: CloudRuntimeState['status']) {
  const keys = {
    not_configured: 'status.cloud.not_configured',
    configured: 'status.cloud.configured',
    connected: 'status.cloud.connected',
    degraded: 'status.cloud.degraded',
  } as const;

  return keys[status];
}

export function sessionStatusKey(status: ClientSessionState['status']) {
  const keys = {
    cloud_only: 'session.cloud_only',
    local_ready: 'session.local_ready',
    hybrid_ready: 'session.hybrid_ready',
    permission_required: 'session.permission_required',
    degraded: 'session.degraded',
    offline: 'session.offline',
  } as const;

  return keys[status];
}

export function authStatusKey(status: AuthState['status']) {
  const keys = {
    not_configured: 'auth.not_configured',
    signed_out: 'auth.signed_out',
    signing_in: 'auth.signing_in',
    authenticated: 'auth.authenticated',
    error: 'auth.error',
  } as const;

  return keys[status];
}

export function isCloudRuntimeUsable(cloudRuntime: CloudRuntimeState | null) {
  return cloudRuntime?.status === 'configured' ||
    cloudRuntime?.status === 'connected' ||
    cloudRuntime?.status === 'degraded';
}

export function formatAuthIdentity(authState: AuthState | null, i18n: I18nRuntime) {
  if (!authState) return i18n.t('status.connecting');
  if (authState.status !== 'authenticated') return i18n.t(authStatusKey(authState.status));
  return authState.user?.nickname ?? authState.user?.name ?? authState.user?.account ?? i18n.t('auth.authenticated');
}

export function avatarInitial(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || 'Z';
}
