const MAX_TEXT = 100_000;
const MAX_REPAIR_TEXT = 4000;

export function finalVerifierText(events = []) {
  let text = '';
  for (const event of events) {
    if (event?.channel === 'chat:stream:tool-call' || event?.channel === 'chat:stream:tool-result') text = '';
    if (event?.channel === 'chat:stream:delta' && typeof event.payload?.content === 'string') text += event.payload.content;
  }
  return text;
}

// Balanced top-level objects only: braces in JSON strings do not split reports.
function objectsIn(text) {
  const objects = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (start < 0) {
      if (char === '{') { start = i; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      try { objects.push(JSON.parse(text.slice(start, i + 1))); } catch { objects.push(null); }
      start = -1;
    }
  }
  return start < 0 ? objects : [];
}

function stringList(value) {
  return value === undefined || (Array.isArray(value) && value.every(item => typeof item === 'string'));
}

function issueList(value) {
  return value === undefined || (Array.isArray(value) && value.every(item => item && typeof item === 'object'
    && !Array.isArray(item) && typeof item.reason === 'string' && item.reason.trim()
    && (item.criterionId == null || typeof item.criterionId === 'string')
    && (item.taskId == null || typeof item.taskId === 'string') && stringList(item.evidenceRefs)));
}

export function decodeVerifierReport(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return null;
  let candidates;
  try {
    const object = JSON.parse(text.trim());
    candidates = [object];
  } catch { candidates = objectsIn(text); }
  // Multiple objects are ambiguous, even if only one claims success.
  if (candidates.length !== 1) return null;
  const report = candidates[0];
  if (!report || Array.isArray(report) || typeof report !== 'object' || typeof report.passed !== 'boolean'
    || !issueList(report.failedCriteria) || !issueList(report.missingEvidence)
    || !stringList(report.risks) || !stringList(report.evidenceRefs)
    || (report.summary != null && typeof report.summary !== 'string')
    || (report.recommendedNextAction != null && typeof report.recommendedNextAction !== 'string')) return null;
  const strings = value => (value || []).map(item => item.trim()).filter(Boolean);
  if (report.passed && strings(report.evidenceRefs).length === 0) return null;
  const issues = value => (value || []).map(item => ({
    ...(item.taskId ? { taskId: item.taskId } : {}),
    ...(item.criterionId ? { criterionId: item.criterionId } : {}),
    reason: item.reason.trim(), evidenceRefs: strings(item.evidenceRefs),
  }));
  return {
    passed: report.passed,
    failedCriteria: issues(report.failedCriteria), missingEvidence: issues(report.missingEvidence),
    risks: strings(report.risks), evidenceRefs: strings(report.evidenceRefs),
    summary: report.summary?.trim() || (report.passed ? 'Verifier passed.' : 'Verifier found issues.'),
    ...(report.recommendedNextAction ? { recommendedNextAction: report.recommendedNextAction } : {}),
  };
}

export async function runVerifierWithReport({ run, signal, allowedEvidenceRefs = null } = {}) {
  let previousText = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Verifier aborted', 'AbortError');
    const { events = [], outcome } = await run({ attempt, previousText });
    if (signal?.aborted) throw new DOMException('Verifier aborted', 'AbortError');
    const failedEvent = events.find(event => ['chat:stream:error', 'chat:stream:aborted'].includes(event?.channel));
    if (failedEvent || outcome?.ok === false || ['error', 'aborted', 'interrupted'].includes(outcome?.terminalStatus)) {
      throw new Error(failedEvent?.payload?.error || outcome?.error || 'Verifier stream failed or aborted');
    }
    const text = finalVerifierText(events);
    const report = decodeVerifierReport(text);
    if (events.some(event => event?.channel === 'chat:stream:tool-result' && deniedResult(event.payload?.result))) {
      throw new Error('Verifier permission denied');
    }
    const allowed = new Set(allowedEvidenceRefs || []);
    for (const event of events) {
      if (event?.channel !== 'chat:stream:tool-result') continue;
      for (const ref of Array.isArray(event.payload?.evidenceRefs) ? event.payload.evidenceRefs : []) {
        if (typeof ref === 'string' && ref.trim()) allowed.add(ref.trim());
      }
    }
    if (report && (!report.passed || allowedEvidenceRefs === null
      || report.evidenceRefs.every(ref => allowed.has(ref)))) return report;
    previousText = text.slice(0, MAX_REPAIR_TEXT);
  }
  return { ok: false, error: 'verifier_report_invalid', passed: false,
    failedCriteria: [], missingEvidence: [], evidenceRefs: [],
    risks: ['Verifier returned no valid structured report after one format retry.'],
    summary: 'Verifier report format invalid after one retry.', recommendedNextAction: 'retry_verification' };
}

function deniedResult(value) {
  let result = value;
  if (typeof value === 'string') { try { result = JSON.parse(value); } catch { return false; } }
  return result?.status === 'denied' || result?.execution?.result?.status === 'denied'
    || result?.execution?.grant?.duration === 'denied' || result?.error === 'permission_denied';
}
