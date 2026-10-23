import type { TuiLocale } from '../tui-language.ts';
import { projectCopy, projectStatus } from './project-copy.ts';
import { terminalText } from './commands.ts';

export function isRecoveryCard(card: any) {
  return ['agent_unavailable', 'agent_stopped'].includes(card.kind);
}

export function cardSummary(locale: TuiLocale, card: any): string {
  if (!isRecoveryCard(card)) return terminalText(card.content);
  if (card.resolvedState === 'resolved') {
    const phase = card.failureStatus?.phase ?? card.resolution?.state;
    if (phase === 'recovered' || phase === 'superseded') return projectCopy(locale, phase);
    if (phase === 'paused' || phase === 'cancelled') return projectStatus(locale, phase);
    return projectCopy(locale, 'resolvedInterruption');
  }
  if (card.kind === 'agent_stopped') return projectCopy(locale, 'stopped');
  const reason = String(card.content ?? '');
  if (/empty_model_response/.test(reason)) return projectCopy(locale, 'emptyResponse');
  if (/ERR_(?:INTERNET|NETWORK|CONNECTION|HTTP2|NAME_NOT_RESOLVED)|network|connect|fetch failed|socket/i.test(reason)) return projectCopy(locale, 'networkError');
  return projectCopy(locale, 'unavailable');
}
