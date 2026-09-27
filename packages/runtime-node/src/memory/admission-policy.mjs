/**
 * 记忆准入。纯函数：决定候选是生效、留作候选，还是拒绝。
 * 推断偏好不满 3 个不同 episode 不生效。
 * 密钥、放宽权限、以及工具 / 网页 / 文件里的「以后都这样做」不落成约定或偏好。
 */
import { memorySecretReason } from './memory-redaction.mjs';

const KINDS = new Set(['fact', 'preference', 'decision', 'procedure', 'responsibility']);
const TRUSTS = new Set(['verified', 'stated', 'inferred']);
const TEXT_MAX = 2000;
const REF_MAX = 200;
const LOOSENING = /不用确认|跳过批准|跳过审批|always allow|skip approval|full_local|不用我批|下调验证|降低验证|提高预算|raise the budget|skip verification/i;
const STANDING = /以后都|下次都|always do this|从现在开始都/i;

export function validateCuratorCandidate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'invalid' };
  if (!KINDS.has(raw.kind) || !TRUSTS.has(raw.trust)) return { ok: false, reason: 'invalid' };
  if (typeof raw.text !== 'string') return { ok: false, reason: 'invalid' };
  const text = raw.text.trim();
  if (!text || text.length > TEXT_MAX) return { ok: false, reason: 'invalid' };
  const evidenceRefs = [];
  if (raw.evidenceRefs != null) {
    if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.length > 16) return { ok: false, reason: 'invalid' };
    for (const ref of raw.evidenceRefs) {
      if (typeof ref !== 'string') return { ok: false, reason: 'invalid' };
      const next = ref.trim();
      if (!next || next.length > REF_MAX) return { ok: false, reason: 'invalid' };
      if (!evidenceRefs.includes(next)) evidenceRefs.push(next);
    }
  }
  return {
    ok: true,
    candidate: {
      kind: raw.kind,
      trust: raw.trust,
      text,
      evidenceRefs,
      untrusted: raw.untrusted === true,
    },
  };
}

export function parseCuratorOutput(text) {
  const body = unwrapJson(text);
  if (!body) return { candidates: [], discarded: [{ reason: 'invalid_json' }] };
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { candidates: [], discarded: [{ reason: 'invalid_json' }] };
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.candidates;
  if (!Array.isArray(list)) return { candidates: [], discarded: [{ reason: 'invalid_json' }] };
  const candidates = [];
  const discarded = [];
  for (const raw of list) {
    const checked = validateCuratorCandidate(raw);
    if (!checked.ok) discarded.push({ reason: checked.reason });
    else candidates.push(checked.candidate);
  }
  return { candidates, discarded };
}

/**
 * @returns {{ decision: 'activate' | 'candidate' | 'reject', reason: string, confirmedCount?: number }}
 */
export function decideMemoryAdmission(raw, context = {}) {
  const checked = validateCuratorCandidate(raw);
  if (!checked.ok) return { decision: 'reject', reason: 'invalid' };
  const item = checked.candidate;
  if (memorySecretReason(item.text)) return { decision: 'reject', reason: 'sensitive' };
  if (LOOSENING.test(item.text)) return { decision: 'reject', reason: 'loosens_policy' };
  const standing = STANDING.test(item.text);
  const preferenceLike = item.kind === 'preference' || item.kind === 'procedure' || item.kind === 'decision' || item.kind === 'responsibility';
  if (item.untrusted === true && (preferenceLike || standing)) {
    return { decision: 'reject', reason: 'untrusted_standing_order' };
  }
  if (context.learnPreferences === false && item.kind === 'preference' && item.trust === 'inferred') {
    return { decision: 'reject', reason: 'preferences_disabled' };
  }
  const contradicts = (Array.isArray(context.contradicts) ? context.contradicts : [])
    .filter((line) => typeof line === 'string')
    .map((line) => normalizeText(line));
  if (contradicts.includes(normalizeText(item.text))) {
    return { decision: 'reject', reason: 'instruction_conflict' };
  }
  const resolvable = new Set(
    (Array.isArray(context.resolvableRefs) ? context.resolvableRefs : [])
      .filter((ref) => typeof ref === 'string' && ref.trim())
      .map((ref) => ref.trim()),
  );
  if (item.trust === 'verified') {
    if (item.kind === 'preference') return { decision: 'reject', reason: 'verified_preference' };
    if (!item.evidenceRefs.some((ref) => resolvable.has(ref))) {
      return { decision: 'reject', reason: 'evidence_unresolved' };
    }
    if (item.untrusted === true) return { decision: 'candidate', reason: 'untrusted_fact' };
    return { decision: 'activate', reason: 'verified' };
  }
  if (item.kind === 'preference' && item.trust === 'inferred') {
    const confirmedCount = episodeCount(context);
    if (confirmedCount < 3) {
      return { decision: 'candidate', reason: 'preference_unconfirmed', confirmedCount };
    }
    return { decision: 'activate', reason: 'inferred_preference', confirmedCount };
  }
  if (item.untrusted === true && item.kind === 'fact') {
    return { decision: 'candidate', reason: 'untrusted_fact' };
  }
  if (item.trust === 'stated') return { decision: 'candidate', reason: 'stated_needs_user_anchor' };
  return { decision: 'candidate', reason: 'not_activated' };
}

function episodeCount(context) {
  if (Array.isArray(context.episodeIds)) {
    return new Set(context.episodeIds.filter((id) => typeof id === 'string' && id.trim())).size;
  }
  if (Number.isInteger(context.confirmedCount) && context.confirmedCount >= 0) return context.confirmedCount;
  return 0;
}

function normalizeText(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function unwrapJson(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : trimmed).trim();
  const objectAt = body.indexOf('{');
  const arrayAt = body.indexOf('[');
  if (objectAt < 0 && arrayAt < 0) return '';
  const cut = objectAt < 0 ? arrayAt : (arrayAt < 0 ? objectAt : Math.min(objectAt, arrayAt));
  return body.slice(cut);
}
