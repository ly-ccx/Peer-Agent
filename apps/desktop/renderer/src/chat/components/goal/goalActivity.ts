import type { GoalPlan } from '@peer-agent/protocol';

/** One factual projection for the conversation strip and the workbench. No timer/heartbeat. */
export function goalActivity(plan: GoalPlan, isZh: boolean, conversationStreaming = false): string {
  const r = plan.runner;
  const text = (zh: string, en: string) => isZh ? zh : en;
  for (const status of [plan.status, r?.status]) {
    if (status === 'completed') return text('执行已结束', 'Execution finished');
    if (status === 'cancelled') return text('任务已取消', 'Task cancelled');
    if (status === 'paused') return text('任务已暂停', 'Task paused');
    if (status === 'interrupted') return conversationStreaming
      ? text('会话输出中 · 任务中断记录待核对', 'Conversation streaming · task interruption recorded')
      : text('上次任务执行中断', 'Previous task run interrupted');
    if (status === 'failed') return text('执行失败，请查看详情', 'Execution failed — view details');
    if (status === 'blocked' || status === 'waiting_user') return text('需要你处理，请查看详情', 'Your attention is needed — view details');
  }
  if (!r || !r.enabled) return text('等待继续执行', 'Waiting to continue');
  const task = plan.tasks.find((t) => t.taskId === r.currentTaskId);
  const runs = (r.explorers ?? []).filter((e) => !r.explorerBatch || e.batchId === r.explorerBatch.batchId);
  const running = runs.filter((e) => e.status === 'running').length;
  const queued = runs.filter((e) => e.status === 'queued').length;
  const subject = task ? ` · ${task.title}` : '';
  if (running) return text(`正在开展 ${running} 项后台调查`, `${running} background investigations running`) + subject;
  if (queued) return text(`${queued} 项调查排队中`, `${queued} investigations queued`) + subject;
  if (runs.some((e) => e.status === 'failed') && ['explore', 'plan_scaffold'].includes(r.phase ?? '')) {
    return text('后台调查失败，主任务正在处理', 'Investigation failed — main task is handling it') + subject;
  }
  if (runs.length && runs.every((e) => e.status === 'completed') && ['explore', 'plan_scaffold'].includes(r.phase ?? '')) {
    return text('调查已返回，正在接续主任务', 'Investigation returned — continuing the main task') + subject;
  }
  if (r.status === 'resuming_after_compaction') return text('正在恢复任务上下文', 'Restoring task context');
  if (r.phase === 'verify') return text('正在验证结果', 'Verifying results') + subject;
  return text('Peer 正在推进', 'Peer is working') + subject;
}
