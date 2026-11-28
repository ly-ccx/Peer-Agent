import type { I18nRuntime } from '@peer-agent/i18n';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { toolPresentation } from '../drawer/agentProcess.ts';
import { isActivityRunning } from './botActivityState.ts';

export interface ReplyActivityLabelOptions {
  /** When false, suppress transient running-tool labels until the reveal threshold elapses. */
  readonly showActiveTool?: boolean;
  /** When true, append monotonic completed-step progress to thinking labels once tools have run. */
  readonly includeProgress?: boolean;
}

const IMMEDIATE_ACTIVE_TOOLS = new Set(['post_reply', 'wait_for_sessions']);

export function completedActivityToolSteps(activity: ProjectAgentActivity | undefined): number {
  if (!activity?.segments?.length) return 0;
  let count = 0;
  for (const segment of activity.segments) {
    if (
      segment.kind === 'tool'
      && segment.name !== 'post_reply'
      && (segment.status === 'done' || segment.status === 'error' || segment.status === 'stopped')
    ) {
      count += 1;
    }
  }
  return count;
}

function thinkingLabel(activity: ProjectAgentActivity, i18n: I18nRuntime, includeProgress: boolean): string {
  if (!includeProgress) return i18n.t('projectAgent.chat.activity.thinking');
  const steps = completedActivityToolSteps(activity);
  if (steps <= 0) return i18n.t('projectAgent.chat.activity.thinking');
  if (steps === 1) return i18n.t('projectAgent.chat.activity.thinkingWithOneStep');
  return i18n.t('projectAgent.chat.activity.thinkingWithSteps', { count: steps });
}

/** Public activity only. Neither tool parameters/results nor reasoning enter the footer. */
export function replyActivityLabel(
  activity: ProjectAgentActivity | undefined,
  i18n: I18nRuntime,
  options?: ReplyActivityLabelOptions,
): string | null {
  if (!activity || !isActivityRunning(activity)) return null;
  const showActiveTool = options?.showActiveTool !== false;
  const includeProgress = options?.includeProgress === true;
  if (activity.phase === 'awaiting_permission') return i18n.t('projectAgent.chat.activity.permission');
  if (activity.phase === 'tool') {
    const tool = [...(activity.segments ?? [])].reverse().find(segment => segment.kind === 'tool'
      && (segment.status === 'preparing' || segment.status === 'running'));
    if (tool?.kind === 'tool' && (showActiveTool || IMMEDIATE_ACTIVE_TOOLS.has(tool.name))) {
      const preparing = tool.status === 'preparing';
      const operation = toolPresentation(tool.name).labelKey;
      if (tool.name === 'list_directory' || tool.name === 'list_files') {
        return i18n.t(preparing ? 'projectAgent.chat.activity.preparing' : 'projectAgent.chat.activity.directory');
      }
      if (tool.name === 'git_query') {
        return i18n.t(preparing ? 'projectAgent.chat.activity.preparing' : 'projectAgent.chat.activity.git');
      }
      if (tool.name === 'wait_for_sessions') {
        return i18n.t(preparing ? 'projectAgent.chat.activity.preparing' : 'projectAgent.chat.activity.waitingSessions');
      }
      if (tool.name === 'post_reply') {
        return i18n.t('projectAgent.chat.activity.responding');
      }
      if (operation === 'projectAgent.chat.toolLabel.read') {
        const name = fileName(tool.summary);
        if (name) return i18n.t(preparing ? 'projectAgent.chat.activity.prepareRead' : 'projectAgent.chat.activity.readFile', { name });
        return i18n.t(preparing ? 'projectAgent.chat.activity.preparing' : 'projectAgent.chat.activity.reading');
      }
      if (['view_image', 'read_image', 'analyze_image'].includes(tool.name)) {
        return i18n.t(preparing ? 'projectAgent.chat.activity.preparing' : 'projectAgent.chat.activity.image');
      }
      if (preparing) return i18n.t('projectAgent.chat.activity.preparing');
      switch (operation) {
        case 'projectAgent.chat.toolLabel.command': return i18n.t('projectAgent.chat.activity.command');
        case 'projectAgent.chat.toolLabel.search': return i18n.t('projectAgent.chat.activity.search');
        case 'projectAgent.chat.toolLabel.webSearch': return i18n.t('projectAgent.chat.activity.webSearch');
        case 'projectAgent.chat.toolLabel.webFetch': return i18n.t('projectAgent.chat.activity.webFetch');
        case 'projectAgent.chat.toolLabel.edit': return i18n.t('projectAgent.chat.activity.edit');
        case 'projectAgent.process.verification': return i18n.t('projectAgent.chat.activity.verification');
        case 'projectAgent.process.start': return i18n.t('projectAgent.chat.activity.delegating');
        case 'projectAgent.process.sessions':
        case 'projectAgent.process.session': return i18n.t('projectAgent.chat.activity.work');
        case 'projectAgent.process.memory': return i18n.t(tool.name === 'memory_search'
          ? 'projectAgent.chat.activity.memory' : 'projectAgent.chat.activity.memoryUpdate');
      }
      return i18n.t('projectAgent.chat.activity.advancing');
    }
    // A result can arrive before the next model event; don't keep claiming it is running.
    return thinkingLabel(activity, i18n, includeProgress);
  }
  switch (activity.phase) {
    case 'waiting': return i18n.t('projectAgent.chat.reply.waitingModel');
    case 'thinking': return thinkingLabel(activity, i18n, includeProgress);
    case 'settling': return i18n.t('projectAgent.chat.activity.settling');
    default: return i18n.t('projectAgent.chat.activity.responding');
  }
}

function fileName(summary: string | undefined): string | null {
  if (!summary || summary.length > 160 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(summary)
    || /\[(?:redacted|truncated)\]|[?=&]|:\/\//i.test(summary)) return null;
  const name = summary.replace(/\\/g, '/').split('/').at(-1)?.trim();
  return name && name.length <= 64 && /^[\p{L}\p{N}_. -]+$/u.test(name) ? name : null;
}
