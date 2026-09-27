const OUTPUT_LIMIT = 2000;
const KINDS = new Set(['screenshot', 'command', 'diff']);
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
  return {
    ok: true,
    evidenceRef,
    kind,
    summary,
    truncated: text.length > summary.length,
  };
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
export function evidenceBodyFromRecord(record, readArtifact = () => '') {
  if (!record || typeof record !== 'object') return null;
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
