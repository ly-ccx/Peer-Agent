import type { BotRowState } from '@peer-agent/protocol';

export type BotAvatarMood = 'idle' | 'working' | 'thinking' | 'waiting_provider' | 'needs_you' | 'error' | 'reply';

/** Motion belongs to the current identity, never to every historical occurrence. */
export function botAvatarMotion(mood: BotAvatarMood, requested = false): boolean {
  return requested && ['working', 'thinking', 'waiting_provider', 'needs_you', 'reply'].includes(mood);
}

/** The expression is a view of known facts; no renderer timer invents agent activity. */
export function botAvatarMood(state: BotRowState, replyArrived = false): BotAvatarMood {
  if (replyArrived) return 'reply';
  if (state.needsYou > 0) return 'needs_you';
  if (state.agentStatus === 'error') return 'error';
  if (state.agentStatus === 'waiting_provider') return 'waiting_provider';
  if (state.agentStatus === 'thinking') return 'thinking';
  // Child tasks have their own status strip; they do not keep the bot in a reply animation.
  return 'idle';
}
