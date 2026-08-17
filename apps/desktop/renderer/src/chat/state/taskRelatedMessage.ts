import type { GoalPlan, TaskOverviewItem } from '@peer-agent/protocol';
import type { ChatMsg } from './types';

/**
 * 定位与当前 Task 最相关的消息：
 * 1) 正文/片段含 planId / taskId
 * 2) 用户消息含 plan.title / plan.goal / item.title
 * 3) 取最后一次匹配，否则回退最后一条消息
 */
export function findTaskRelatedMessageId(
  messages: readonly ChatMsg[],
  item: TaskOverviewItem,
  plan: GoalPlan | null,
): string | null {
  if (messages.length === 0) return null;

  const needles: string[] = [];
  if (item.taskId) needles.push(item.taskId);
  if (item.title?.trim()) needles.push(item.title.trim());
  if (plan?.planId) needles.push(plan.planId);
  if (plan?.title?.trim()) needles.push(plan.title.trim());
  if (plan?.goal?.trim()) {
    const g = plan.goal.trim();
    needles.push(g.length > 40 ? g.slice(0, 40) : g);
  }

  const uniqueNeedles = [...new Set(needles.filter((n) => n.length >= 2))];
  if (uniqueNeedles.length === 0) {
    return messages[messages.length - 1]?.id ?? null;
  }

  let lastIdMatch: string | null = null;
  let lastTitleMatch: string | null = null;

  for (const msg of messages) {
    const blob = messageSearchBlob(msg);
    if (!blob) continue;
    if (item.taskId && blob.includes(item.taskId)) {
      lastIdMatch = msg.id;
      continue;
    }
    if (plan?.planId && blob.includes(plan.planId)) {
      lastIdMatch = msg.id;
      continue;
    }
    for (const needle of uniqueNeedles) {
      if (needle === item.taskId || needle === plan?.planId) continue;
      if (blob.includes(needle)) {
        if (msg.role === 'user') lastTitleMatch = msg.id;
        else if (!lastTitleMatch) lastTitleMatch = msg.id;
      }
    }
  }

  return lastIdMatch || lastTitleMatch || messages[messages.length - 1]?.id || null;
}

function messageSearchBlob(msg: ChatMsg): string {
  const parts: string[] = [];
  if (msg.content) parts.push(msg.content);
  if (Array.isArray(msg.segments)) {
    for (const seg of msg.segments) {
      if (!seg || typeof seg !== 'object') continue;
      if ((seg as { type?: string }).type === 'text' && typeof (seg as { content?: string }).content === 'string') {
        parts.push((seg as { content: string }).content);
      }
      if ((seg as { type?: string }).type === 'tool-call') {
        const name = (seg as { name?: string; tool?: string }).name || (seg as { tool?: string }).tool || '';
        const args =
          (seg as { arguments?: unknown; args?: unknown }).arguments ?? (seg as { args?: unknown }).args;
        parts.push(name);
        if (args != null) {
          try {
            parts.push(typeof args === 'string' ? args : JSON.stringify(args));
          } catch {
            // ignore
          }
        }
      }
    }
  }
  return parts.join('\n');
}
