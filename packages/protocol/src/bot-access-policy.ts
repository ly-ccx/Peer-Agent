import type { LocalAccessLevel } from './index.ts';

/** Device-local user authority. Never supplied by a model or copied into a worker profile. */
export interface BotAccessPolicy {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly accessLevel: LocalAccessLevel;
  readonly revision: number;
  readonly updatedAt: string;
  readonly source: 'legacy_migration' | 'new_bot' | 'local_ui';
}

export interface BotAccessPolicyReadRequest {
  readonly workspaceId?: string;
  readonly conversationId?: string;
}
export interface BotAccessPolicyUpdateRequest {
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly accessLevel: LocalAccessLevel;
}
export type BotAccessPolicyResult =
  | { readonly ok: true; readonly policy: BotAccessPolicy | null; readonly inherited: boolean; readonly botName?: string }
  | { readonly ok: false; readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'OUT_OF_SCOPE' | 'POLICY_CONFLICT' | 'POLICY_UNAVAILABLE' | 'PROJECT_AGENT_DISABLED'; readonly policy?: BotAccessPolicy };
