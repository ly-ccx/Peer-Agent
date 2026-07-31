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

export function contextAccountingRestoreKey({
  conversationId,
  snapshot,
  providerId,
  model,
}: {
  conversationId: string;
  snapshot: ContextAccountingSnapshot | null;
  providerId: string | null | undefined;
  model: string | null | undefined;
}): string {
  const modelKey = contextAccountingModelKey(providerId, model);
  const contentRevision = snapshot?.contentRevision ?? 'missing';
  return `${conversationId}\u0000${modelKey}\u0000${contentRevision}`;
}

export function shouldStartContextAccountingRestore({
  attemptedKeys,
  ...restore
}: {
  attemptedKeys: ReadonlySet<string>;
  conversationId: string;
  snapshot: ContextAccountingSnapshot | null;
  providerId: string | null | undefined;
  model: string | null | undefined;
}): boolean {
  return shouldRestoreContextAccounting(restore)
    && !attemptedKeys.has(contextAccountingRestoreKey(restore));
}
