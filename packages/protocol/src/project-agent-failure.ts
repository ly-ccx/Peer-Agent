import type { DelegationEvent } from './delegation.ts';

/** Host failure classification, including the persisted diagnostic prefix used by older cards. */
export function projectAgentFailureKind(reason: unknown): 'budget_exhausted' | 'unavailable' {
  if (typeof reason !== 'string') return 'unavailable';
  const code = reason.trim().replace(/^代理暂时不可用：\s*/, '');
  return /^(agent_tool_budget_exhausted|agent_loop_exhausted|work_budget_limited)(?:\s*:|$)/.test(code)
    ? 'budget_exhausted' : 'unavailable';
}

/** Durable host facts for an explicit retry; never a new user authorization. */
export interface ProjectAgentTurnRecovery {
  readonly events: readonly DelegationEvent[];
  readonly throughSeq: number;
}

/** Factual recovery data returned by post_reply after anchor validation fails. */
export interface ReplyAnchorCandidate {
  readonly messageId: string;
  readonly text: string;
}
