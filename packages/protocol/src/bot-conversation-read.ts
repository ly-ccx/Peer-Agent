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
