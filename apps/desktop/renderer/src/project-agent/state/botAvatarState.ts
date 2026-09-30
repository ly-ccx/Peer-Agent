import type { BotRowState } from '@peer-agent/protocol';

export type BotAvatarMood = 'idle' | 'working' | 'thinking' | 'waiting_provider' | 'needs_you' | 'error' | 'reply';

/** The expression is a view of known facts; no renderer timer invents agent activity. */
export function botAvatarMood(state: BotRowState): BotAvatarMood {
  if (state.needsYou > 0) return 'needs_you';
  if (state.agentStatus === 'error') return 'error';
  if (state.agentStatus === 'waiting_provider') return 'waiting_provider';
  if (state.agentStatus === 'thinking') return 'thinking';
  if (state.running > 0) return 'working';
  return 'idle';
}
