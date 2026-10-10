import type { I18nRuntime } from '@peer-agent/i18n';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { toolPresentation } from '../drawer/agentProcess.ts';
import { isActivityRunning } from './botActivityState.ts';

/** Public activity only. Neither tool parameters/results nor reasoning enter the footer. */
export function replyActivityLabel(activity: ProjectAgentActivity | undefined, i18n: I18nRuntime): string | null {
  if (!activity || !isActivityRunning(activity)) return null;
  if (activity.phase === 'tool') {
    const tool = [...activity.segments].reverse().find(segment => segment.kind === 'tool'
      && (segment.status === 'preparing' || segment.status === 'running'));
    if (tool?.kind === 'tool') {
      const preparing = tool.status === 'preparing';
      const operation = toolPresentation(tool.name).labelKey;
      if (tool.name === 'list_directory') return i18n.t(preparing ? 'projectAgent.chat.activity.preparing' : 'projectAgent.chat.activity.directory');
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
    return i18n.t('projectAgent.chat.activity.thinking');
  }
  switch (activity.phase) {
    case 'waiting': return i18n.t('projectAgent.chat.activity.preparing');
    case 'thinking': return i18n.t('projectAgent.chat.activity.thinking');
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
