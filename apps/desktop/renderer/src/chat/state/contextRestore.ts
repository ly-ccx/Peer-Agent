import type { ContextAccountingSnapshot } from '@peer-agent/protocol';
import { contextAccountingModelKey } from '@peer-agent/protocol';

export function shouldRestoreContextAccounting({
  snapshot,
  providerId,
  model,
}: {
  snapshot: ContextAccountingSnapshot | null;
  providerId: string | null | undefined;
  model: string | null | undefined;
}): boolean {
  if (!snapshot) return true;
  if (snapshot.pressureSource === 'unknown') return true;
  return snapshot.modelKey !== contextAccountingModelKey(providerId, model);
}
