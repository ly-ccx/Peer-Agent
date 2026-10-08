import type { BotProfile } from './project.ts';
import type { ModelReasoningEffort } from './model-reasoning.ts';

/** A user choice for the Bot's future replies; never a per-input runtime override. */
export interface BotModelSelectionUpdateRequest {
  readonly workspaceId: string;
  readonly modelProviderId: string;
  readonly reasoningEffort?: ModelReasoningEffort;
}

export interface BotModelSelectionUpdateResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly profile?: BotProfile;
}
