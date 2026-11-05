import { boundedJSON, canonicalJSON } from '@peer-agent/interactive-content/values';
import { redactOutputSecrets } from '../project-agent/output-redaction.mjs';

const secretField = /^(?:password|passwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|credential)$/i;

/** Receives bounded JSON. A redaction flag describes actual changed bytes, not source verification. */
export function redactInteractiveJSON(raw, { observeTruncation = false } = {}) {
  let redacted = false, truncated = false;
  function visit(value) {
    if (typeof value === 'string') { const clean = redactOutputSecrets(value); redacted ||= clean !== value; return clean; }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (observeTruncation && /truncat/i.test(key) && child === true) truncated = true;
      if (secretField.test(key)) { redacted = true; return [key, '[REDACTED]']; }
      return [key, visit(child)];
    }));
    return value;
  }
  return { value: visit(raw), redacted, truncated };
}

/** Parse errors mean plain text; invalid/over-budget JSON remains an error, not an unredacted fallback. */
export function redactInteractiveJSONText(raw, limits) {
  const text = redactOutputSecrets(raw);
  let json;
  try { json = JSON.parse(text); }
  catch { return { text, parsed: false, redacted: text !== raw }; }
  const sanitized = redactInteractiveJSON(boundedJSON(json, limits));
  const changed = text !== raw || sanitized.redacted;
  return { text: changed ? canonicalJSON(sanitized.value) : text, json: sanitized.value, parsed: true, redacted: changed };
}
