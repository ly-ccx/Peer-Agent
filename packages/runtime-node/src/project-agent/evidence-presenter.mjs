import { redactShellOutput } from './output-redaction.mjs';

const OUTPUT_LIMIT = 2000;
const KINDS = new Set(['screenshot', 'command', 'diff', 'file', 'observation']);
const TOKEN_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const URI_REF = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/;

/**
 * 证据正文只在 main 里裁成摘要。渲染层拿到的是这段摘要和引用，不读文件。
 */
export function presentEvidence(body = {}) {
  const evidenceRef = typeof body.evidenceRef === 'string' ? body.evidenceRef.trim() : '';
  const text = typeof body.text === 'string' ? body.text : '';
  const summary = Array.from(text).slice(0, OUTPUT_LIMIT).join('');
  const kind = KINDS.has(body.kind) ? body.kind : 'command';
  const availability = body.availability ?? (text.trim() ? 'available' : 'metadata_only');
  return {
    ok: availability === 'available',
    evidenceRef,
    kind,
    summary,
    truncated: body.truncated === true || text.length > summary.length,
    availability,
    ...(body.source ? { source: evidenceSourceDescription(body.source, evidenceRef) } : {}),
    ...(availability === 'metadata_only' ? { code: 'BODY_NOT_SAVED' } : {}),
    ...(availability === 'unavailable' ? { code: 'READ_FAILED' } : {}),
  };
}

/** Only canonical index metadata is admitted to the source list. */
export function evidenceSourceDescription(record = {}, evidenceRef = record.evidenceRef) {
  return { evidenceRef,
    ...(typeof record.toolName === 'string' ? { toolName: record.toolName.slice(0, 120) } : {}),
    ...(typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt)) ? { createdAt: record.createdAt } : {}),
  };
}

const QUERY_TOOLS = new Set(['get_session', 'list_sessions', 'get_verification_detail']);

/** Recover only a registered query's saved Tool Result, never narration or current task state. */
export function evidenceBodyFromHistory(record, messages = []) {
  if (!record?.conversationId || !record.streamId || !QUERY_TOOLS.has(record.toolName)
    || record.capabilityId !== `local.delegation.${record.toolName}`) return null;
  const history = typeof messages === 'function' ? messages(record.conversationId) : messages;
  const message = history.find(row => row.kind === 'agent_turn' && (row.turnId ?? row.id) === record.streamId);
  for (const round of message?.rounds ?? []) for (const call of round.toolCalls ?? []) {
    const result = call.result;
    if (call.name !== record.toolName || result?.ok !== true || !Array.isArray(result.evidenceRefs) || !result.evidenceRefs.includes(record.evidenceRef)) continue;
    const rows = record.toolName === 'list_sessions' ? result.sessions : [result.session ?? result];
    if (!Array.isArray(rows)) return null;
    const chunks = [];
    for (const row of rows.slice(0, 20)) {
      for (const value of [row?.title, row?.statusLabel, row?.report?.summary, row?.summary]) {
        if (typeof value === 'string' && value.trim()) chunks.push(value.trim().slice(0, 4001));
      }
    }
    const raw = chunks.join('\n');
    if (!raw) return null;
    const text = redactShellOutput(raw).slice(0, 4000);
    return { evidenceRef: record.evidenceRef, kind: 'observation', text, truncated: raw.length > 4000 || rows.length > 20 };
  }
  return null;
}

/** 已登记的证据引用。允许 tool-result:// 和 local-shell-artifact://…/stdout，拒绝路径穿越。 */
export function evidenceRefAllowed(evidenceRef) {
  if (typeof evidenceRef !== 'string') return false;
  const value = evidenceRef.trim();
  if (!value || value.length > 500 || value.includes('..') || /[\s\u0000-\u001f\\]/.test(value)) return false;
  if (/^file:/i.test(value)) return false;
  return URI_REF.test(value) || TOKEN_REF.test(value);
}

/**
 * 从证据索引记录里取出可展示的正文。
 * 索引本身没有 output / summary；用产物预览，或调用方读到的工件文本。
 * readArtifact 只会被记录上的 artifactRefs 调用。
 */
/** @param {any} record @param {(ref: string, record?: any) => string} [readArtifact] */
export function evidenceBodyFromRecord(record, readArtifact = () => '') {
  if (!record || typeof record !== 'object') return null;
  if (['file', 'command'].includes(record.bodyPreview?.kind) && typeof record.bodyPreview.text === 'string') {
    return {
      evidenceRef: record.evidenceRef, kind: record.bodyPreview.kind, text: record.bodyPreview.text,
      truncated: record.bodyPreview.truncated === true,
    };
  }
  const chunks = [];
  let kind = kindFromTool(record.toolName);
  for (const artifact of Array.isArray(record.userArtifacts) ? record.userArtifacts : []) {
    const preview = artifact?.preview;
    if (preview?.kind === 'code' && Array.isArray(preview.diffLines) && preview.diffLines.length > 0) {
      kind = 'diff';
      chunks.push(preview.diffLines.filter((line) => typeof line === 'string').join('\n'));
      continue;
    }
    if (artifact?.kind === 'image' || preview?.kind === 'image') {
      kind = 'screenshot';
      const label = typeof artifact.label === 'string' && artifact.label.trim()
        ? artifact.label.trim()
        : (typeof artifact.ref === 'string' ? artifact.ref.trim() : '');
      if (label) chunks.push(label);
    }
  }
  for (const ref of Array.isArray(record.artifactRefs) ? record.artifactRefs : []) {
    if (typeof ref !== 'string' || !ref.trim()) continue;
    const text = readArtifact(ref.trim(), record);
    if (typeof text !== 'string' || !text.trim()) continue;
    if (/diff/i.test(ref)) kind = 'diff';
    else if (/screenshot|image|png|jpe?g|webp/i.test(ref)) kind = 'screenshot';
    chunks.push(text);
  }
  const text = chunks.join('\n').trim();
  if (!text) return null;
  return { evidenceRef: record.evidenceRef, kind, text };
}

function kindFromTool(toolName) {
  const name = typeof toolName === 'string' ? toolName : '';
  if (/screenshot|image/i.test(name)) return 'screenshot';
  if (/diff/i.test(name)) return 'diff';
  return 'command';
}
