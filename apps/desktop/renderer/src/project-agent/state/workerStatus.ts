import type { I18nRuntime } from '@peer-agent/i18n';
import { WORK_SESSION_STATUSES } from '@peer-agent/protocol';
import { isActivelyVerifying, isAwaitingBotReport, isVerificationFailed, type TaskStatusFacts } from './drawerState.ts';

type WorkerTone = 'warn' | 'danger' | 'active' | 'good' | 'queued' | 'muted' | 'waiting';

export function workerStatus(
  task: TaskStatusFacts,
  i18n: Pick<I18nRuntime, 'locale' | 't'>,
): { readonly text: string; readonly tone: WorkerTone } {
  const isZh = Boolean(i18n.locale?.startsWith('zh'));
  const { status, followUp } = task;
  if (isVerificationFailed(task)) {
    return { text: i18n.t('projectAgent.chat.work.verificationFailed'), tone: 'danger' };
  }
  if (isActivelyVerifying(task)) {
    return { text: i18n.t('projectAgent.chat.sessionState.verifying'), tone: 'active' };
  }
  if (isAwaitingBotReport(task)) {
    return { text: i18n.t('projectAgent.chat.work.awaitingReport'), tone: 'waiting' };
  }
  if (status === 'failed') return { text: isZh ? '执行失败' : 'Execution failed', tone: 'danger' };
  if (followUp?.owner === 'user' || status === 'waiting_user' || status === 'needs_user') {
    return { text: isZh ? '待你确认' : 'Needs decision', tone: 'warn' };
  }
  if (status === 'running' || status === 'starting') {
    return { text: isZh ? '执行中' : 'Running', tone: 'active' };
  }
  if (status === 'accepted') return { text: isZh ? '已完成' : 'Completed', tone: 'good' };
  if (status === 'cancelled' || status === 'superseded') {
    return { text: isZh ? '已停止' : 'Stopped', tone: 'muted' };
  }

  const knownStatus = WORK_SESSION_STATUSES.find(known => known === status);
  return {
    text: knownStatus ? i18n.t(`projectAgent.chat.sessionState.${knownStatus}`) : i18n.t('projectAgent.chat.work.unavailable'),
    tone: status === 'queued' ? 'queued' : status === 'result_ready' ? 'good' : 'muted',
  };
}
