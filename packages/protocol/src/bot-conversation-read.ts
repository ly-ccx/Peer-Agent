/** Independent read sections; availability never grants execution authority. */
export type BotConversationReadView = 'interactions' | 'cards';
export interface BotConversationReadAvailability {
  readonly section: 'messages' | 'cards';
  readonly state: 'ready' | 'rebuilding' | 'unavailable';
  readonly sourceVersion?: string;
  readonly code?: string;
}

/** Small durable accounting event; full results and provider checkpoints remain referenced. */
export interface CoordinationUsageObservation {
  readonly kind: 'usage_observed';
  readonly workId: string;
  readonly observationId: string;
  readonly tokens: number | null;
  readonly costUsd: number | null;
}

/** A durable input receipt is independent of this execution/recovery barrier. */
export interface BotRecoveryStatus {
  readonly state: 'blocked';
  readonly reason: 'history_conflict' | 'reconciliation_required' | 'recovery_failed';
  readonly code: string;
  readonly phase: string;
  readonly retryable: boolean;
}

export function projectBotRecoveryStatus(error: unknown, phase = 'unknown'): BotRecoveryStatus {
  const code = typeof error === 'string' && /^[a-zA-Z0-9_:-]{1,120}$/.test(error) ? error : 'RECOVERY_FAILED';
  const conflict = ['coordination_legacy_changed', 'coordination_hash_mismatch', 'coordination_journal_missing',
    'coordination_legacy_seal_invalid', 'coordination_repair_incomplete', 'coordination_fence_incomplete', 'coordination_fence_invalid', 'coordination_writer_fence_missing',
    'coordination_writer_upgrade_required', 'coordination_schema_unsupported'].includes(code);
  const held = code === 'coordination_reconciliation_required';
  return { state: 'blocked', reason: held ? 'reconciliation_required' : conflict ? 'history_conflict' : 'recovery_failed', code,
    phase: /^[a-z_]{1,40}$/.test(phase) ? phase : 'unknown', retryable: !conflict && !held };
}
