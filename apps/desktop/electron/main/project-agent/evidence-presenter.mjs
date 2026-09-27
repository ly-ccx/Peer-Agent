const OUTPUT_LIMIT = 2000;
const KINDS = new Set(['screenshot', 'command', 'diff']);

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

export function evidenceRefAllowed(evidenceRef) {
  return typeof evidenceRef === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(evidenceRef.trim());
}
