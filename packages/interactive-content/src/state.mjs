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

/** Human-readable selected conditions, without exposing storage IDs or state keys. */
export function projectStateText(content, state, { fields = Object.keys(content.stateSchema), isZh = false } = {}) {
  const schemaKeys = Object.keys(content.stateSchema), labels = new Map(); let nodes = 0;
  if (!Array.isArray(fields) || fields.length > L.stateFields || new Set(fields).size !== fields.length
    || fields.some(key => !Object.hasOwn(content.stateSchema, key))) reject('invalid_state');
  function visit(node, depth = 0) {
    if (!node || typeof node !== 'object' || ++nodes > L.expandedNodes || depth > L.expandedDepth || node.type !== 'element' || !node.props) return;
    const props = node.props;
    if (typeof node.stateTarget === 'string' && typeof props.label === 'string' && props.label.length <= 160 && !labels.has(node.stateTarget)) labels.set(node.stateTarget, props.label);
    if (['Col', 'Row', 'Card'].includes(node.typeName) && Array.isArray(props.children)) for (const child of props.children.slice(0, L.expandedNodes)) visit(child, depth + 1);
  }
  visit(content.tree);
  return fields.map(key => {
    const label = labels.get(key) ?? `${isZh ? '条件' : 'Condition'} ${schemaKeys.indexOf(key) + 1}`;
    const raw = state.inputDrafts?.[key] ?? state.values[key];
    if (!(typeof raw === 'boolean' || typeof raw === 'number' && Number.isFinite(raw) || typeof raw === 'string' && raw.length <= L.textChars)) reject('invalid_state');
    const value = typeof raw === 'boolean' ? raw ? (isZh ? '是' : 'Yes') : (isZh ? '否' : 'No') : String(raw);
    return `${label}: ${value}`;
  }).join('\n');
}
