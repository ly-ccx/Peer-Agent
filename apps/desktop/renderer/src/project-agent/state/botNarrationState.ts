import type { ProjectAgentPublicUpdate } from '@peer-agent/protocol';

export type BotNarrationSegment = ProjectAgentPublicUpdate;

/** Public assistant text only. Thinking events never enter either input. */
export function botNarration(updates: readonly BotNarrationSegment[], finalText = ''): readonly BotNarrationSegment[] {
  const segments = updates.filter(segment => segment.text.trim());
  // A fallback reply (or stopped card) can repeat the last public text segment.
  // Keep earlier updates and avoid displaying that last segment twice.
  const last = segments.at(-1);
  return last && sameText(last.text, finalText) ? segments.slice(0, -1) : segments;
}

function sameText(left: string, right: string): boolean {
  return left.trim().replace(/\s+/g, ' ') === right.trim().replace(/\s+/g, ' ');
}
