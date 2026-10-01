/**
 * 任务结束后的验证结论与签收。
 * 结论只走宿主传入的证据索引。任务上自带的 evidenceRefs 不能自己证明自己。
 * 模型自述和「用户已同意」参数不参与判定。
 * 代签还要求代理已经用回复引用过这条任务，并且关闭闸门通过。
 * 非只读任务改动超过 20 个文件时改为需要确认。协议的判定函数没有这条原因，所以在它的结果上追加。
 */
import {
  decideAcceptance,
  evaluateAcceptanceCloseGate,
} from '@peer-agent/protocol';

import { computeVerificationVerdict } from './verification-verdict.mjs';
import { createHash } from 'node:crypto';

export function isHandoffConflict(handoff) {
  return handoff?.status === 'stopped'
    && !['acceptance_required', 'handoff_confirmation_required'].includes(handoff.stoppedReason);
}

export function handoffQuestionId(handoff, acceptedAt) {
  const conflict = isHandoffConflict(handoff);
  return `handoff${conflict ? '_conflict' : ''}-${createHash('sha256').update(JSON.stringify([
    acceptedAt, ...(conflict ? [handoff.updatedAt, handoff.commitSha, handoff.stoppedReason] : []),
  ])).digest('hex').slice(0, 16)}`;
}

export const CHANGED_FILE_CONFIRM_LIMIT = 20;

const REVIEW_REQUEST = /确认一下|给我看看|等我确认|先让我确认|先别签|let me review|ask me to confirm/i;

export function anchorRequestsReview(text) {
  return typeof text === 'string' && REVIEW_REQUEST.test(text);
}

export function verdictRefFor(sessionId, outcome) {
  const id = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'session';
  const result = typeof outcome === 'string' && outcome.trim() ? outcome.trim() : 'unknown';
  return `verdict:${id}:${result}`;
}

/**
 * @param {object} [facts] 宿主事实。`userAgreed`、`acceptedBy`、`userOverride` 一律忽略。
 * @param {{ userConfirm?: boolean }} [options] 只有宿主的用户确认入口会把 userConfirm 设为 true。
 */
export function decideSessionAcceptance(facts = {}, options = {}) {
  const plan = facts.plan && typeof facts.plan === 'object' ? facts.plan : {};
  const sessionId = typeof facts.sessionId === 'string' ? facts.sessionId.trim() : '';
  const evidenceIndex = facts.evidenceIndex instanceof Set || Array.isArray(facts.evidenceIndex)
    ? facts.evidenceIndex
    : [];
  const hostAuthority = facts.hostAuthority && typeof facts.hostAuthority === 'object' ? facts.hostAuthority : {};
  const verdict = computeVerificationVerdict(plan, evidenceIndex, hostAuthority);
  const verdictRef = verdictRefFor(sessionId, verdict.outcome);
  const closeGatePassed = evaluateAcceptanceCloseGate(plan).ok === true;
  const policy = facts.policy === 'confirm' ? 'confirm' : 'auto';
  const reported = facts.reported === true;
  const readOnly = facts.readOnly === true;
  const changedFiles = uniquePaths(facts.changedFiles);
  const userConfirm = options.userConfirm === true;
  const decision = decideAcceptance({
    verdict,
    policy,
    session: {
      manualCriteriaPending: facts.manualCriteriaPending === true,
      externalSideEffects: facts.externalSideEffects === true,
      destructiveOperation: facts.irreversible === true,
      outOfScopeWrite: facts.outOfScopeWrite === true,
      userRequestedReview: anchorRequestsReview(facts.anchorText),
      verificationBelowFloor: facts.verificationBelowFloor === true,
      reported,
      closeGatePassed,
    },
    userOverride: userConfirm ? { accept: true } : null,
  });
  const reasons = [...decision.reasons];
  let mode = decision.mode;
  let acceptedBy = decision.acceptedBy;
  if (!readOnly && changedFiles.length > CHANGED_FILE_CONFIRM_LIMIT) {
    if (!reasons.includes('changed_files_over_limit')) reasons.push('changed_files_over_limit');
    mode = 'confirm';
    if (acceptedBy === 'policy') acceptedBy = undefined;
  }
  if (userConfirm && closeGatePassed && mode === 'confirm' && acceptedBy !== 'policy') {
    acceptedBy = 'user';
  }
  return {
    verdict,
    verdictRef,
    mode,
    ...(acceptedBy ? { acceptedBy } : {}),
    reasons,
    reported,
    closeGatePassed,
  };
}

function uniquePaths(value) {
  const paths = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const raw = typeof item === 'string' ? item : item?.path;
    if (typeof raw !== 'string') continue;
    const filePath = raw.trim();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    paths.push(filePath);
  }
  return paths;
}
