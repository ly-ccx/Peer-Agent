import type { AuthState } from '@zeus-atlas/protocol';

export function getWorkId(authState: AuthState | null): string | undefined {
  if (authState?.status !== 'authenticated') return undefined;
  return authState.user?.empId ?? authState.user?.account;
}
