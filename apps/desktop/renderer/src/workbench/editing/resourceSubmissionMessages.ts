import type { ResourceSubmissionState } from './resourceSubmissionController.ts';
import { resourceEditOutcome, resourceEditMessage } from './resourceEditMessages.ts';
export function resourceSubmissionIssue(code: string, isZh: boolean): string {
  const pair = /SUBMIT_INPUT_CHANGED/.test(code) ? ['固定提交稿前输入发生了变化，这次尚未提交。新输入已保留，请明确再提交当前稿。', 'Input changed before the submission was fixed. Nothing was submitted in this attempt. The new input is preserved; explicitly submit the current draft when ready.']
    : /SUBMIT_UNCONFIRMED|STATUS_UNAVAILABLE|OPERATION_MISSING/.test(code) ? ['这次提交尚未确认。草稿保留，请先核对原请求，不要重复写入。', 'This submission is unconfirmed. The draft is preserved. Check the original request before another write.']
    : /OPERATION_PENDING/.test(code) ? ['这个文件还有未结算的提交。请先在修改记录中核对原操作。', 'This file has an unsettled submission. Check the original operation in edit history first.']
    : /TRANSPORT_LIMIT/.test(code) ? ['这个入口仍有较多未返回的调用。草稿保留，请正常重新连接应用后读取原记录，不要重跑写入。', 'This view still has too many unresolved calls. The draft is preserved. Reconnect the app normally and read the original records without replaying writes.']
    : /RECEIPT_CONFLICT|EXECUTION_CONFLICT|ID_CONFLICT/.test(code) ? ['原提交身份或回执存在冲突。草稿与已知依据保留，请核对原记录，不要重写。', 'The original submission identity or receipt conflicts. Drafts and known evidence are preserved. Reconcile the original record without another write.']
    : /NEW_BASE_REQUIRED/.test(code) ? ['原文件已写回，当前草稿仍保留旧基础。先比较当前文件，再另建草稿继续。', 'The file was updated, while this draft retains its old base. Compare the current file and create a separate draft to continue.']
    : /SUBMISSION_NOT_ACCEPTED/.test(code) ? ['已关闭原入口并再次核对：原请求未受理，草稿保留。取得编辑权后可明确重新提交。', 'The old view is closed and the request was checked again: it was not accepted. The draft is preserved. Reclaim editing before a new explicit submission.']
    : /NO_CHANGES/.test(code) ? ['当前稿与基础相同，没有待提交的修改。', 'The draft matches its base. There are no changes to submit.']
    : /^no_change$/.test(code) ? ['实际内容与提交稿相同，没有再次改写文件。', 'The actual content matches the submitted text. The file was not rewritten.']
    : /SAVE_PENDING|SUBMISSION_LOADING/.test(code) ? ['正在确认已保存草稿与原提交记录。', 'Checking the saved draft and original submission records.']
    : /permission_timeout|PERMISSION_EXPIRED/.test(code) ? ['本次授权已过期，未据此批准写入。草稿和原记录保留。', 'This permission request expired and did not authorize a write. The draft and original record are preserved.']
    : /permission_policy_changed|access_identity_invalid|access_policy_unavailable/.test(code) ? ['本次权限或所属关系已失效，写入未获批准。请检查原 Bot 的权限后再决定。', 'The permission policy or owner identity changed. The write was not authorized. Check the original Bot’s permissions before deciding again.']
    : /local_user_denied|hook_denied|hook_approval_denied/.test(code) ? ['本次写入已被拒绝，原文件未因此次拒绝而修改。草稿保留。', 'This write was denied. The denial did not modify the file. The draft is preserved.']
    : /SCOPE_DENIED|permission_not_granted|permission_unavailable/.test(code) ? ['当前来源或权限不允许这次写入，访问范围没有扩大。草稿保留。', 'The current source or permissions do not allow this write. Access was not expanded. The draft is preserved.']
    : /FILE_NOT_FOUND|ENOENT/.test(code) ? ['原文件不存在或已移动，未改为另一个目标。草稿保留。', 'The original file is missing or moved. No alternative target was chosen. The draft is preserved.']
    : /VERSION_CHANGED/.test(code) ? ['原文件已变化，本次没有覆盖它。请比较原基础、提交稿与当前文件。', 'The file changed and this submission did not overwrite it. Compare the original base, submitted text and current file.']
    : /WRITE_UNCONFIRMED|RESULT_UNCERTAIN|EXECUTION_UNCONFIRMED/.test(code) ? ['文件可能已部分写入。请核对原操作与当前文件，不要重跑写入。', 'The file may have been partially written. Reconcile the original operation and current file without replaying the write.']
    : /BODY_CLEANED/.test(code) ? ['这份提交稿的留存正文已清理，原执行记录仍保留。', 'Retained text for this submission was cleared. Its original execution record remains.']
    : /HISTORY_CHANGED/.test(code) ? ['历史记录已整理，请重读这次固定稿。原执行依据保留。', 'History was managed. Read this fixed submission again. Original execution evidence is preserved.']
    : /execution_cancelled|permission_cancelled/.test(code) ? ['本次请求已取消。实际是否写入以原回执为准，草稿保留。', 'The request was cancelled. Its original receipt determines whether a write occurred. The draft is preserved.']
    : /EACCES|EPERM/.test(code) ? ['系统不允许写入这个文件。请检查文件权限，草稿保留。', 'The operating system does not allow writing this file. Check file permissions. The draft is preserved.']
    : /ENOSPC|EDQUOT/.test(code) ? ['磁盘空间或配额不足。若写入已开始，请先核对原结果。草稿保留。', 'Disk space or quota is insufficient. If writing started, reconcile its original result first. The draft is preserved.'] : null;
  return pair ? pair[isZh ? 0 : 1]! : resourceEditMessage(code, isZh);
}
export function resourceSubmissionLabel(state: ResourceSubmissionState, isZh: boolean) {
  const pick = (zh: string, en: string) => isZh ? zh : en, status = state.status;
  if (state.intent) return state.action === 'submit' ? pick('正在确认提交受理', 'Confirming submission receipt') : pick('提交受理尚未确认', 'Submission receipt unconfirmed');
  if (!status) return !state.ready ? pick('提交记录暂未就绪', 'Submission records not ready') : state.selectedId ? pick('原提交记录保留，状态待核对', 'Original submission preserved; status needs checking') : pick('尚未提交原文件', 'Not submitted to file');
  if (status.permission) return pick('等待你批准本次写入', 'Waiting for your write decision');
  if (status.permissionElsewhere) return pick('请到发起窗口处理本次授权', 'Handle this permission in its originating window');
  const op = status.operation;
  if (op.phase === 'prepared') return pick('提交稿已固定，尚未执行', 'Submission fixed; not executed');
  if (op.phase === 'uncertain') return pick('写入结果待核对', 'Write result needs reconciliation');
  if (op.phase === 'running') return status.live ? pick('正在处理文件提交', 'Processing file submission') : pick('原执行尚无回执，请核对', 'Original execution has no receipt; reconcile');
  if (op.receipt?.outcome === 'cancelled' && !op.receipt.toolCallId) return pick('提交意图已撤回', 'Submission intent withdrawn');
  if (op.receipt?.outcome === 'applied') {
    if (status.governance === 'unconfirmed' || status.governance === 'pending' && !status.live) return pick('已写回；后置检查未确认', 'Applied; post-check unconfirmed');
    if (status.governance === 'pending') return pick('已写回；后置检查进行中', 'Applied; post-check in progress');
    if (state.execution?.postlude?.hooks?.some(hook => hook.decision === 'deny' || !!hook.outcome && hook.outcome !== 'ok')) return pick('已写回；运行检查有异常', 'Applied; runtime checks need attention');
  }
  return resourceEditOutcome(op.receipt?.outcome, isZh);
}
