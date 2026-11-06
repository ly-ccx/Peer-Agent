import type { ResourceEditReceipt } from '@peer-agent/protocol';
export function resourceEditMessage(code: string, isZh: boolean): string {
  const pair = /WRITER_BUSY|HOST_BUSY/.test(code) ? ['草稿正在另一处编辑，可只读查看或明确接管。', 'This draft is being edited elsewhere. Read it or explicitly take over.']
    : /STALE_WRITER/.test(code) ? ['编辑权已转移。你的输入已保留，重新取得编辑权后再保存。', 'Editing moved to another view. Your input is preserved. Reclaim editing before saving.']
    : /LOCAL_CONFLICT|REVISION/.test(code) ? ['已保存的草稿发生变化。你的输入已保留，请比较后选择保留哪份内容。', 'The saved draft changed. Your input is preserved. Compare before choosing what to keep.']
    : /TEXT_LIMIT/.test(code) ? ['草稿仅支持 1 MiB 内的 UTF-8 文本，不支持 NUL 或无效字符。当前输入保留。', 'Drafts support UTF-8 text up to 1 MiB, without NUL or invalid characters. Your input is preserved.']
    : /COMPOSITION_ACTIVE/.test(code) ? ['请先完成输入法组合输入，再保存或关闭。', 'Finish composing text before saving or closing.']
    : /SOURCE_CHANGED|RECIPIENT_CHANGED|VIEW_EXPIRED/.test(code) ? ['来源或所属会话已变化，当前输入保留。请回到原 Bot 重新打开草稿。', 'The source or conversation changed. Input is preserved. Reopen this draft in its original Bot.']
    : /DRAFT_MISSING/.test(code) ? ['已保存的草稿不存在，当前尚未保存的输入仍保留，可复制带走。', 'The saved draft is missing. Unsaved input is preserved and can be copied.']
    : /LIMIT|QUOTA/.test(code) ? ['本机草稿空间或视图数量已达上限，当前输入保留。请先整理已保存的草稿。', 'Local draft storage or view capacity is full. Your input is preserved. Manage saved drafts first.']
    : /SAVE_UNCONFIRMED/.test(code) ? ['保存结果尚未确认，输入已保留。请重读已保存内容核对后重试。', 'The save is unconfirmed. Input is preserved. Read the saved draft before retrying.']
    : ['暂时无法完成草稿操作，当前输入保留，可重试。', 'The draft operation is unavailable. Input is preserved. Retry.'];
  return pair[isZh ? 0 : 1]!;
}

export function resourceEditOutcome(outcome: ResourceEditReceipt['outcome'] | undefined, isZh: boolean) {
  const labels = { applied: ['已写入原文件', 'Applied to file'], conflict: ['原文件版本冲突', 'File version conflict'], denied: ['授权已拒绝', 'Permission denied'], cancelled: ['已取消', 'Cancelled'], failed: ['执行失败', 'Execution failed'] };
  return outcome ? labels[outcome][isZh ? 0 : 1] : (isZh ? '已结算' : 'Settled');
}
