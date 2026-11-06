import type { BrowserResourceFeedbackNotice } from '@peer-agent/protocol';
export function browserFeedbackNoticeText(notice: BrowserResourceFeedbackNotice, isZh: boolean): string {
  if (notice.phase === 'preparing') return isZh ? '正在准备引用草稿…' : 'Preparing the reference draft…';
  if (notice.phase === 'prepared') return isZh ? '已加入原 Bot 的输入草稿，尚未发送。' : 'Added to the original Bot’s input draft; not sent.';
  if (notice.phase === 'unconfirmed') return isZh ? '草稿保存尚未确认；可对同一选区重试，尚未发送。' : 'Draft saving was not confirmed. Retry the same selection; it has not been sent.';
  return feedbackPreparationFailureText(notice.code, isZh);
}
export function feedbackPreparationFailureText(code: string | undefined, isZh: boolean): string {
  if (code === 'DRAFT_PREPARATION_UNCONFIRMED' || code === 'DRAFT_SAVE_FAILED') return isZh ? '草稿保存尚未确认；引用保留，可重试，尚未发送。' : 'Draft saving was not confirmed. The reference is preserved; retry. It has not been sent.';
  if (code === 'SOURCE_CHANGED') return isZh ? '资源或选区来源已变化，请重新选择；未替换为其他资源。' : 'The resource or selection source changed. Select it again; no other resource was substituted.';
  if (code === 'RESOURCE_FEEDBACK_RECIPIENT_CHANGED') return isZh ? '原 Bot 会话已变化，引用未转发到其他会话。' : 'The original Bot conversation changed. The reference was not forwarded to another conversation.';
  if (code === 'RESOURCE_FEEDBACK_LIMIT') return isZh ? '引用数量已达上限，请先在原 Bot 草稿中移除部分引用。' : 'The reference limit was reached. Remove a reference from the original Bot’s draft first.';
  return isZh ? '暂时无法准备引用草稿，可重试；尚未发送。' : 'Unable to prepare the reference draft. Retry; it has not been sent.';
}
