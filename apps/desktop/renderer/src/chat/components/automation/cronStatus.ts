import type { AgentCronSessionRecord } from '@zeus-atlas/protocol';
import { recordString } from '../../utils/records.ts';

export type AutomationStatusFilter = 'running' | 'paused' | 'ended' | 'all';

export function cronStatusLabel(status: string | undefined) {
  if (!status) return '未知';
  if (status === 'active' || status === 'running') return '运行中';
  if (status === 'paused') return '已暂停';
  if (status === 'stopped') return '已停止';
  if (status === 'waiting_prerequisite') return '等待条件';
  if (status === 'completed') return '已结束';
  if (status === 'archived') return '已归档';
  if (status === 'succeeded') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'skipped') return '跳过';
  if (status === 'blocked') return '阻塞';
  if (status === 'cancelled') return '已取消';
  return status;
}

export function cronStatusTone(status: string | undefined) {
  if (status === 'active' || status === 'running' || status === 'succeeded') return 'success';
  if (status === 'failed' || status === 'blocked' || status === 'cancelled') return 'danger';
  if (status === 'paused' || status === 'stopped' || status === 'completed' || status === 'archived') return 'neutral';
  return 'warning';
}

export function cronSessionStatus(session: AgentCronSessionRecord) {
  return session.status || session.schedule?.status || recordString(session, ['state', 'sessionStatus', 'statusName']);
}

export function cronStatusBucket(session: AgentCronSessionRecord): AutomationStatusFilter {
  const status = cronSessionStatus(session);
  if (status === 'paused') return 'paused';
  if (status === 'stopped' || status === 'completed' || status === 'archived') return 'ended';
  if (status === 'active' || status === 'running' || status === 'waiting_prerequisite') return 'running';
  return 'all';
}
