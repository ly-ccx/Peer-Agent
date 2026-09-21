import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const statements = value => Array.isArray(value) && value.length <= 20
  && value.every(text => typeof text === 'string' && text.trim().length > 0 && text.length <= 2000);

/** Snapshot only the adapter's answer fields; do not retain prompts/messages.
 * Digests detect mutation after return, not model understanding or authenticity.
 */
export function snapshotVisualResponse(response, wire) {
  const text = wire === 'anthropic' ? response?.textContent : response?.content;
  const tools = wire === 'anthropic' ? response?.toolUseBlocks : response?.toolCalls;
  const serialized = JSON.stringify({ ok: response?.ok, status: response?.status,
    content: response?.content, textContent: response?.textContent,
    toolCalls: response?.toolCalls, toolUseBlocks: response?.toolUseBlocks,
    streamError: response?.streamError, providerError: response?.providerError,
    stopReason: response?.stopReason, finishReason: response?.finishReason });
  return { text, hasTools: tools != null && (!Array.isArray(tools) || tools.length > 0),
    responseHash: hash(serialized) };
}

/** Host-only diagnostic. Even a valid "passed" candidate NEVER grants admission.
 * Strict full JSON, exact observation coverage, and no model-supplied identities.
 * Persist only counts/digests of findings; never the raw answer or image bytes.
 */
export function inspectVisualJudgmentCandidate(snapshot, observations) {
  if (snapshot.hasTools) return { status: 'tool-response' };
  if (typeof snapshot.text !== 'string' || !snapshot.text.trim()) return { status: 'missing' };
  if (Buffer.byteLength(snapshot.text, 'utf8') > 64 * 1024) return { status: 'invalid', reason: 'too-large' };
  let value;
  try { value = JSON.parse(snapshot.text); } catch { return { status: 'invalid', reason: 'json' }; }
  if (!exactKeys(value, ['kind', 'version', 'assessments']) || value.kind !== 'ui_visual_judgment'
    || value.version !== 1 || !Array.isArray(value.assessments)) return { status: 'invalid', reason: 'schema' };
  const expected = new Map(observations.map(observation => [observation.artifactRef, observation]));
  if (!expected.size || value.assessments.length !== expected.size) return { status: 'invalid', reason: 'coverage' };
  const seen = new Set();
  const assessments = [];
  for (const item of value.assessments) {
    if (!exactKeys(item, ['artifactRef', 'verdict', 'findings', 'repairSuggestions'])
      || !['passed', 'failed', 'inconclusive'].includes(item.verdict)
      || !statements(item.findings) || !item.findings.length || !statements(item.repairSuggestions)) {
      return { status: 'invalid', reason: 'schema' };
    }
    const observation = expected.get(item.artifactRef);
    if (!observation || seen.has(item.artifactRef)) return { status: 'invalid', reason: 'coverage' };
    seen.add(item.artifactRef);
    assessments.push({ artifactRef: observation.artifactRef, artifactHash: observation.artifactHash,
      verdict: item.verdict, findingsCount: item.findings.length, findingsHash: hash(JSON.stringify(item.findings)),
      repairSuggestionsCount: item.repairSuggestions.length, repairSuggestionsHash: hash(JSON.stringify(item.repairSuggestions)) });
  }
  return { status: 'validated-candidate', assessments };
}
