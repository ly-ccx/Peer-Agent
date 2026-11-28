import type { I18nRuntime } from '@peer-agent/i18n';
import type { ProjectAgentActivity, ProjectAgentToolActivity } from '@peer-agent/protocol';
import type { BotReplyRow } from './botReplyContinuity';
import { isActivityRunning } from './botActivityState.ts';
import { replyPresenceState } from './replyPresenceState.ts';

/**
 * Minimum time a tool must stay active before the chat status line switches from
 * monotonic thinking progress to a specific active-tool caption. Prevents 2-50ms
 * local read/search tools from flashing and snapping back within a second.
 */
export const SLOW_TOOL_REVEAL_DELAY_MS = 350;

const IMMEDIATE_TOOLS = new Set(['post_reply', 'wait_for_sessions']);

export interface LiveToolRevealPlan {
  readonly toolId: string | null;
  readonly revealActiveTool: boolean;
  readonly waitMs: number;
}

function activeToolSegment(activity: ProjectAgentActivity | undefined): ProjectAgentToolActivity | undefined {
  if (!activity || !isActivityRunning(activity) || activity.phase !== 'tool') return undefined;
  const segments = activity.segments ?? [];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment?.kind === 'tool' && (segment.status === 'preparing' || segment.status === 'running')) {
      return segment;
    }
  }
  return undefined;
}

function parseIsoTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function activeToolRevealPlan(
  activity: ProjectAgentActivity | undefined,
  nowMs: number,
  firstSeenAtMs?: number,
): LiveToolRevealPlan {
  const tool = activeToolSegment(activity);
  if (!tool) return { toolId: null, revealActiveTool: false, waitMs: 0 };
  if (IMMEDIATE_TOOLS.has(tool.name)) {
    return { toolId: tool.id, revealActiveTool: true, waitMs: 0 };
  }
  const parsedStart = parseIsoTimestampMs(tool.startedAt);
  const originMs = parsedStart !== null && parsedStart <= nowMs
    ? parsedStart
    : firstSeenAtMs ?? nowMs;
  const elapsedMs = Math.max(0, nowMs - originMs);
  if (elapsedMs >= SLOW_TOOL_REVEAL_DELAY_MS) {
    return { toolId: tool.id, revealActiveTool: true, waitMs: 0 };
  }
  return {
    toolId: tool.id,
    revealActiveTool: false,
    waitMs: SLOW_TOOL_REVEAL_DELAY_MS - elapsedMs,
  };
}

export function stableReplyPresenceState(
  reply: BotReplyRow,
  i18n: I18nRuntime,
  nowMs: number,
  firstSeenAtMs?: number,
) {
  const plan = activeToolRevealPlan(reply.activity, nowMs, firstSeenAtMs);
  return {
    ...replyPresenceState(reply, i18n, {
      showActiveTool: plan.revealActiveTool,
      includeProgress: true,
    }),
    revealActiveTool: plan.revealActiveTool,
    waitMs: plan.waitMs,
    toolId: plan.toolId,
  };
}
