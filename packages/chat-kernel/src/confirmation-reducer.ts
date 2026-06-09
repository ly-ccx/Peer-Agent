import type {
  PendingHumanConfirmation,
  ResolvedHumanConfirmation,
} from '@peer-agent/protocol';

export function replacePendingConfirmation(
  pending: readonly PendingHumanConfirmation[],
  next: PendingHumanConfirmation,
): readonly PendingHumanConfirmation[] {
  const existingIndex = pending.findIndex((item) => item.confirmationId === next.confirmationId);
  if (existingIndex < 0) return [...pending, next];

  return pending.map((item, index) => (index === existingIndex ? next : item));
}

export function removeResolvedConfirmation(
  pending: readonly PendingHumanConfirmation[],
  resolved: ResolvedHumanConfirmation,
): readonly PendingHumanConfirmation[] {
  return pending.filter((item) => item.confirmationId !== resolved.confirmationId);
}

export function normalizePendingHumanConfirmation(data: unknown): PendingHumanConfirmation | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const candidate =
    (record.pendingHumanConfirmation as unknown) ??
    (record.pendingConfirmation as unknown) ??
    (record.confirmation as unknown) ??
    data;

  if (!candidate || typeof candidate !== 'object') return null;
  const confirmation = candidate as Record<string, unknown>;
  if (typeof confirmation.confirmationId !== 'string') return null;
  if (typeof confirmation.executionUuid !== 'string') return null;

  return {
    confirmationId: confirmation.confirmationId,
    executionUuid: confirmation.executionUuid,
    ...(typeof confirmation.title === 'string' ? { title: confirmation.title } : {}),
    ...(typeof confirmation.message === 'string' ? { message: confirmation.message } : {}),
    ...(typeof confirmation.timing === 'string'
      ? { timing: confirmation.timing as PendingHumanConfirmation['timing'] }
      : {}),
    ...(confirmation.step && typeof confirmation.step === 'object'
      ? { step: confirmation.step as PendingHumanConfirmation['step'] }
      : {}),
    ...(confirmation.exposedContext && typeof confirmation.exposedContext === 'object'
      ? { exposedContext: confirmation.exposedContext as Record<string, unknown> }
      : {}),
    status: 'pending',
  };
}
