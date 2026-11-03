import { boundedJSON, INTERACTIVE_LIMITS as L, reject, utf8Bytes } from './limits.mjs';

/** State persistence shares the engine's validation without loading the parser or React. */
export function validateValues(values, schema) {
  const normalized = boundedJSON(values, { maxBytes: L.stateBytes, maxItems: L.stateFields });
  if (Array.isArray(normalized) || Object.keys(normalized).some(key => !Object.hasOwn(schema, key)) || Object.keys(schema).some(key => !Object.hasOwn(normalized, key))) reject('invalid_state');
  for (const [key, rule] of Object.entries(schema)) {
    const value = normalized[key];
    if (typeof value !== rule.type || rule.type === 'number' && (!Number.isFinite(value) || value < (rule.min ?? -Infinity) || value > (rule.max ?? Infinity))
      || rule.options && !rule.options.includes(value)) reject('invalid_state', key);
  }
  return normalized;
}
export function validateState(values, schema, drafts = {}) {
  const normalized = validateValues(values, schema);
  const inputDrafts = boundedJSON(drafts, { maxBytes: L.stateBytes, maxItems: L.stateFields });
  if (!inputDrafts || Array.isArray(inputDrafts) || Object.entries(inputDrafts).some(([key, value]) => !Object.hasOwn(schema, key)
    || !['string', 'number'].includes(schema[key].type) || typeof value !== 'string' || value.length > 8192)) reject('invalid_input_draft');
  if (utf8Bytes({ values: normalized, inputDrafts }) > L.stateBytes) reject('resource_limit');
  return { values: normalized, inputDrafts };
}
