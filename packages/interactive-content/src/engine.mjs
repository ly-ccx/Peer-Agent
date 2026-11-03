import { createParser, createStore, evaluateRoot } from '@openuidev/lang-core';
import { catalogSpec, COMPONENT_SCHEMAS, createPeerLibrary, runtimeFunctions } from './catalog.mjs';
import { boundedJSON, canonicalJSON, CONTENT_SCHEMA_VERSION, ENGINE_VERSION, INTERACTIVE_LIMITS as L, LIBRARY_VERSION, reject, utf8Bytes } from './limits.mjs';
import { inspectProgram, rejectEngineData } from './policy.mjs';
import { checkNumericExpressions } from './numeric-policy.mjs';
import { validateValues } from './state.mjs';
export { validateState } from './state.mjs';

export async function digestJSON(value) {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJSON(value)));
  return `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
let identityPromise;
export function catalogIdentity() { return identityPromise ??= digestJSON(catalogSpec()); }

function normalizeBindings(raw) {
  const bindings = boundedJSON(raw ?? {}, { maxBytes: L.inputBytes });
  if (Array.isArray(bindings) || Object.keys(bindings).length > L.bindings) reject('invalid_binding');
  rejectEngineData(bindings);
  return bindings;
}
function compile(program, bindings) {
  const policy = inspectProgram(program, bindings);
  const library = createPeerLibrary({ bindings });
  const parsed = createParser(library.toJSONSchema()).parse(program);
  if (!parsed.root && !parsed.rootExpression || parsed.meta.incomplete || parsed.meta.unresolved.length || parsed.meta.errors.length
    || parsed.queryStatements.length || parsed.mutationStatements.length) reject('invalid_program', parsed.meta.errors[0]?.path ?? '', parsed.meta.errors[0]?.code ?? '');
  if (canonicalJSON(parsed.stateDeclarations) !== canonicalJSON(policy.defaults)) reject('invalid_state_declaration');
  return { program, bindings, policy, library, parsed };
}

function render(compiled, values, refineSchema = false) {
  const schema = Object.fromEntries(Object.entries(compiled.policy.defaults).map(([key, value]) => [key, { type: typeof value }]));
  const budget = { remaining: L.evaluationSteps };
  const functions = runtimeFunctions(compiled.library, budget);
  try { checkNumericExpressions(compiled.policy.declarations, values, functions); }
  catch (error) { if (budget.remaining < 0) reject('resource_limit', '', 'evaluation_steps'); throw error; }
  const store = createStore();
  store.initialize(compiled.policy.defaults, values);
  const errors = [];
  let tree;
  try {
    tree = evaluateRoot(compiled.parsed, { library: compiled.library, store, errors, ctx: {
      getState: key => store.get(key),
      resolveRef: () => reject('invalid_reference'),
      functions,
      reportError: () => reject('evaluation_failed'),
    } });
  } catch (error) { if (budget.remaining < 0) reject('resource_limit', '', 'evaluation_steps'); throw error; }
  finally { store.dispose(); }
  if (!tree || errors.length) reject('evaluation_failed');
  let count = 0;
  const ids = new Set();
  function node(current, depth) {
    if (!current || current.type !== 'element' || !Object.hasOwn(COMPONENT_SCHEMAS, current.typeName) || current.partial) reject('invalid_component');
    if (++count > L.expandedNodes || depth > L.expandedDepth) reject('resource_limit');
    const props = { ...current.props };
    let stateTarget;
    if (['Input', 'NumberInput', 'Select', 'Checkbox', 'Slider'].includes(current.typeName)) {
      const descriptor = props.value;
      if (!descriptor || descriptor.__reactive !== 'assign' || !Object.hasOwn(schema, descriptor.target)
        || canonicalJSON(descriptor.expr) !== canonicalJSON({ k: 'StateRef', n: '$value' })) reject('invalid_state_binding');
      stateTarget = descriptor.target;
      props.value = values[stateTarget];
      if (ids.has(props.id)) reject('duplicate_component_id');
      ids.add(props.id);
    }
    // Action plans are validated against their original AST by policy; no callbacks enter data.
    const checkProps = current.typeName === 'Button' ? { ...props, action: { type: 'local' } } : props;
    const checked = COMPONENT_SCHEMAS[current.typeName].strict().safeParse(checkProps);
    if (!checked.success) reject('invalid_component_props', current.typeName, checked.error.issues[0]?.path.join('.'));
    if (stateTarget) {
      const rule = schema[stateTarget];
      if (typeof props.value !== rule.type) reject('invalid_state', stateTarget);
      if (['NumberInput', 'Slider'].includes(current.typeName)) {
        if (props.min > props.max) reject('invalid_component_props');
        rule.min = Math.max(rule.min ?? -Infinity, props.min); rule.max = Math.min(rule.max ?? Infinity, props.max);
      }
      if (current.typeName === 'Select') {
        if (new Set(props.options.map(option => option.value)).size !== props.options.length) reject('invalid_component_props');
        const options = props.options.map(option => option.value);
        rule.options = rule.options ? rule.options.filter(option => options.includes(option)) : options;
      }
    }
    if (['Col', 'Row', 'Card'].includes(current.typeName)) props.children = props.children.map(child => node(child, depth + 1));
    if (current.typeName === 'Table' || current.typeName === 'Chart') {
      const rows = boundedJSON(props.rows, { budget });
      for (const row of rows) if (!row || typeof row !== 'object' || Array.isArray(row)) reject('invalid_component_props');
      if (current.typeName === 'Chart') {
        if (rows.length * props.series.length > L.chartPoints || new Set(props.series.map(series => series.key)).size !== props.series.length) reject('resource_limit');
        if (new Set(rows.map(row => canonicalJSON(row[props.xKey]))).size !== rows.length) reject('duplicate_row_key');
        for (const row of rows) {
          if (!['string', 'number'].includes(typeof row[props.xKey])) reject('invalid_component_props');
          for (const series of props.series) if (typeof row[series.key] !== 'number' || !Number.isFinite(row[series.key])) reject('non_finite_value');
        }
      } else {
        if (new Set(props.columns.map(column => column.key)).size !== props.columns.length) reject('invalid_component_props');
        for (const row of rows) if (!['string', 'number'].includes(typeof row[props.rowKey])) reject('invalid_row_key');
        if (new Set(rows.map(row => canonicalJSON(row[props.rowKey]))).size !== rows.length) reject('duplicate_row_key');
      }
      props.rows = rows;
    }
    return { type: 'element', typeName: current.typeName, ...(current.statementId ? { statementId: current.statementId } : {}), props,
      ...(stateTarget ? { stateTarget } : {}) };
  }
  const normalizedTree = node(tree, 0);
  if (utf8Bytes(normalizedTree) > L.inputBytes * 2) reject('resource_limit');
  validateValues(values, schema);
  return { tree: normalizedTree, ...(refineSchema ? { stateSchema: schema } : {}), componentCount: count, evaluationSteps: L.evaluationSteps - budget.remaining };
}

export async function validateDraft(draft, { bindings = {}, expectedSpecHash } = {}) {
  if (!draft || typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 160 || typeof draft.textFallback !== 'string'
    || !draft.textFallback.trim() || utf8Bytes(draft.textFallback) > L.fallbackBytes) reject('invalid_draft');
  const normalizedBindings = normalizeBindings(bindings);
  const compiled = compile(draft.program, normalizedBindings);
  const initialValues = boundedJSON(compiled.policy.defaults, { maxBytes: L.stateBytes });
  const initial = render(compiled, initialValues, true);
  const specHash = await catalogIdentity();
  if (expectedSpecHash && expectedSpecHash !== specHash) reject('incompatible_catalog');
  return {
    schemaVersion: CONTENT_SCHEMA_VERSION, engine: ENGINE_VERSION, libraryVersion: LIBRARY_VERSION, specHash,
    title: draft.title.trim(), textFallback: draft.textFallback, program: draft.program,
    bindings: normalizedBindings, initialValues, stateSchema: initial.stateSchema,
    stateSchemaHash: await digestJSON(initial.stateSchema), numberPolicy: 'IEEE754; Decimal uses fixed 0-6 places; units are explicit',
    tree: initial.tree,
  };
}

export async function evaluate(content, values = content.initialValues) {
  if (content.schemaVersion !== CONTENT_SCHEMA_VERSION || content.engine !== ENGINE_VERSION || content.libraryVersion !== LIBRARY_VERSION
    || content.specHash !== await catalogIdentity() || content.stateSchemaHash !== await digestJSON(content.stateSchema)) reject('incompatible_catalog');
  const state = validateValues(values, content.stateSchema);
  const compiled = compile(content.program, normalizeBindings(content.bindings));
  return { ...render(compiled, state), values: state, stateDigest: await digestJSON(state), contentVersion: content.contentVersion ?? null, specHash: content.specHash };
}

/** Bounded factual view; a model-authored fallback remains labeled separately by the host. */
export function projectText(tree, maxChars = 12_000) {
  const lines = [];
  function visit(node) {
    const p = node.props;
    if (['Title', 'Text', 'Caption'].includes(node.typeName)) lines.push(p.text);
    else if (node.typeName === 'Card') lines.push(p.title);
    else if (node.typeName === 'Metric') lines.push(`${p.label}: ${p.value}${p.unit ? ` ${p.unit}` : ''}`);
    else if (['Input', 'NumberInput', 'Select', 'Checkbox', 'Slider'].includes(node.typeName)) lines.push(`${p.label}: ${p.value}`);
    else if (node.typeName === 'Table') {
      const pageRows = Math.min(L.tablePageRows, Math.floor(L.tablePageCells / p.columns.length));
      lines.push(p.label, p.columns.map(column => column.label).join(' | '));
      for (const row of p.rows.slice(0, pageRows)) lines.push(p.columns.map(column => String(row[column.key] ?? '')).join(' | '));
      if (p.rows.length > pageRows) lines.push(`[showing ${pageRows} of ${p.rows.length} rows]`);
    } else if (node.typeName === 'Chart') {
      lines.push(p.label, [p.xKey, ...p.series.map(series => series.label)].join(' | '));
      for (const row of p.rows.slice(0, L.tablePageRows)) lines.push([row[p.xKey], ...p.series.map(series => row[series.key])].join(' | '));
      if (p.rows.length > L.tablePageRows) lines.push(`[showing ${L.tablePageRows} of ${p.rows.length} chart rows]`);
    } else if (node.typeName === 'SourceReference') lines.push(`${p.label} [binding:${p.bindingId}]`);
    for (const child of p.children ?? []) visit(child);
  }
  visit(tree);
  const text = lines.join('\n');
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
}
