import type { AgentCronSessionRecord, Conversation } from '@zeus-atlas/protocol';
import { collectValuesByKey, compactLine, recordNumber, recordString } from '../../utils/records';

export {
  type AutomationStatusFilter,
  cronSessionStatus,
  cronStatusBucket,
  cronStatusLabel,
  cronStatusTone,
} from './cronStatus';

export function cronSessionId(session: AgentCronSessionRecord) {
  return session.sessionId ?? compactLine((session as Record<string, unknown>).id);
}

export function cronSessionTitle(session: AgentCronSessionRecord) {
  const title = (
    session.title ||
    recordString(session, ['name', 'sessionName', 'taskName', 'taskTitle', 'displayName', 'conversationTitle']) ||
    cronSessionId(session) ||
    'Automation'
  );
  return /^\d+$/.test(title) ? 'Automation' : title;
}

export function cronScheduleLine(session: AgentCronSessionRecord) {
  const schedule = session.schedule;
  if (!schedule) return session.status ?? '';
  return [
    schedule.triggerType,
    schedule.cronExpr,
    typeof schedule.intervalMs === 'number' ? `${Math.round(schedule.intervalMs / 60000)}m` : '',
    schedule.nextRunAt,
  ].filter(Boolean).join(' / ');
}

function cronIntervalLabel(intervalMs: number) {
  const minutes = Math.round(intervalMs / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

export function cronScheduleLabel(session: AgentCronSessionRecord) {
  const schedule = session.schedule;
  if (!schedule) return '-';
  if (typeof schedule.intervalMs === 'number' && schedule.intervalMs > 0) return cronIntervalLabel(schedule.intervalMs);
  return schedule.cronExpr ?? schedule.onceRunAt ?? schedule.triggerType ?? '-';
}

export function cronPromptLine(session: AgentCronSessionRecord) {
  return (
    session.description ||
    recordString(session, [
      'prompt',
      'instruction',
      'taskPrompt',
      'cronPrompt',
      'userPrompt',
      'message',
      'content',
      'goal',
      'query',
    ]) ||
    '未提供任务描述'
  );
}

export function compactSessionCode(value: string | undefined) {
  if (!value) return '';
  return value.length > 16 ? `${value.slice(0, 11)}...${value.slice(-6)}` : value;
}

export function cronStat(session: AgentCronSessionRecord, keys: readonly string[]) {
  const stats = session.runStats;
  if (!stats) return 0;
  return recordNumber(stats, keys) ?? 0;
}

export function cronStopLine(session: AgentCronSessionRecord) {
  return recordString(session, ['stopCondition', 'stopReason', 'completeReason', 'completionReason']) || '-';
}

export function cronDeliveryLine(session: AgentCronSessionRecord) {
  return recordString(session, ['sendTarget', 'targetName', 'receiverName', 'channelName', 'sourceChannel']) ||
    session.ownerWorkId ||
    '-';
}

export function automationConversationTitle(
  session: AgentCronSessionRecord,
  conversations: readonly Conversation[],
  index: number,
) {
  const title = cronSessionTitle(session);
  if (title !== 'Automation') return title;

  const candidateIds = new Set<string>();
  const sessionId = cronSessionId(session);
  if (sessionId) candidateIds.add(sessionId);
  if (session.activeScheduleId) candidateIds.add(session.activeScheduleId);

  const matchedConversation = conversations.find((conversation) => {
    if (candidateIds.size === 0) return false;
    const metadataValues = new Set<string>();
    collectValuesByKey(conversation.metadata, 'sessionId', metadataValues);
    collectValuesByKey(conversation.metadata, 'cronSessionId', metadataValues);
    collectValuesByKey(conversation.metadata, 'scheduleId', metadataValues);
    return Array.from(candidateIds).some((candidateId) => metadataValues.has(candidateId));
  });
  if (matchedConversation?.title) return matchedConversation.title;

  return conversations[conversations.length - 1 - index]?.title || title;
}
