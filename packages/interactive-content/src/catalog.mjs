import { action, createLibrary, defineComponent, defineFunction, markReactive } from '@openuidev/lang-core';
import { z } from 'zod/v4';
import { boundedJSON, canonicalJSON, INTERACTIVE_LIMITS as L, LIBRARY_VERSION, reject } from './limits.mjs';

const text = () => z.string().max(L.textChars);
const label = () => z.string().min(1).max(160);
const key = () => z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const numeric = () => z.number().finite();
const children = () => z.array(z.any()).max(L.expandedNodes);
function binding(schema) { markReactive(schema); return schema; }

// Property order is the positional language contract, shared with Peer renderers.
export const COMPONENT_SCHEMAS = Object.freeze({
  Col: z.object({ children: children() }),
  Row: z.object({ children: children() }),
  Card: z.object({ title: label(), children: children() }),
  Title: z.object({ text: text() }),
  Text: z.object({ text: text() }),
  Caption: z.object({ text: text() }),
  Divider: z.object({}),
  Metric: z.object({ label: label(), value: z.union([text(), numeric()]), unit: z.string().max(32).optional() }),
  Table: z.object({ label: label(), columns: z.array(z.object({ key: key(), label: label() })).min(1).max(20), rows: z.array(z.any()).max(L.collectionItems), rowKey: key() }),
  Chart: z.object({ label: label(), kind: z.enum(['bar', 'line']), xKey: key(), series: z.array(z.object({ key: key(), label: label() })).min(1).max(L.chartSeries), rows: z.array(z.any()).max(L.chartPoints) }),
  Input: z.object({ id: key(), label: label(), value: binding(text()) }),
  NumberInput: z.object({ id: key(), label: label(), value: binding(numeric()), min: numeric(), max: numeric(), step: numeric().positive() }),
  Select: z.object({ id: key(), label: label(), value: binding(text()), options: z.array(z.object({ value: text(), label: label() })).min(1).max(100) }),
  Checkbox: z.object({ id: key(), label: label(), value: binding(z.boolean()) }),
  Slider: z.object({ id: key(), label: label(), value: binding(numeric()), min: numeric(), max: numeric(), step: numeric().positive() }),
  Button: z.object({ label: label(), action: action() }),
  SourceReference: z.object({ bindingId: key(), label: label() }),
});

export const COMPONENT_DESCRIPTIONS = Object.freeze({
  Col: 'Vertical layout.', Row: 'Responsive horizontal layout.', Card: 'Titled group.',
  Title: 'Result heading.', Text: 'Plain factual or explanatory text.', Caption: 'Supporting plain text.', Divider: 'Section separator.',
  Metric: 'Labeled number or text, with explicit unit.', Table: 'Bounded table with local pagination.',
  Chart: 'Bounded bar or line chart with equivalent data table.',
  Input: 'Labeled text state binding.', NumberInput: 'Labeled finite numeric state binding; min/max/positive step.',
  Select: 'Labeled local selection from declared options.', Checkbox: 'Labeled boolean state binding.',
  Slider: 'Labeled bounded numeric state binding.', Button: 'Local @Set or @Reset action only.',
  SourceReference: 'Source for an admitted literal bindingId; never a URL or path.',
});

const finite = value => { if (typeof value !== 'number' || !Number.isFinite(value)) reject('non_finite_value'); return value; };
const rows = value => { if (!Array.isArray(value) || value.length > L.collectionItems) reject('resource_limit'); return value; };
const ownValue = (row, field) => row && typeof row === 'object' && Object.hasOwn(row, field) ? row[field] : null;

function functionDefinitions(bindings = {}) {
  return [
    defineFunction({ name: 'Data', description: 'Read an admitted immutable data binding by literal bindingId.', params: z.object({ bindingId: key() }), returns: z.any(), fn: ({ bindingId }) => {
      if (!Object.hasOwn(bindings, bindingId)) reject('invalid_binding', bindingId);
      return bindings[bindingId];
    } }),
    defineFunction({ name: 'RowsWhere', description: 'Filter finite rows by own field, comparison eq/ne/gt/gte/lt/lte/contains and scalar value.', params: z.object({ rows: z.array(z.any()), field: key(), comparison: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains']), value: z.union([text(), numeric(), z.boolean(), z.null()]) }), returns: z.array(z.any()), fn: ({ rows: input, field, comparison, value }) => rows(input).filter(row => {
      const actual = ownValue(row, field);
      if (comparison === 'eq') return actual === value;
      if (comparison === 'ne') return actual !== value;
      if (comparison === 'contains') return typeof actual === 'string' && typeof value === 'string' && actual.includes(value);
      if (typeof actual !== 'number' || typeof value !== 'number') return false;
      return comparison === 'gt' ? actual > value : comparison === 'gte' ? actual >= value : comparison === 'lt' ? actual < value : actual <= value;
    }) }),
    defineFunction({ name: 'Total', description: 'Sum finite numeric own-field values. Missing/non-numeric values are errors.', params: z.object({ rows: z.array(z.any()), field: key() }), returns: numeric(), fn: ({ rows: input, field }) => finite(rows(input).reduce((sum, row) => finite(sum + finite(ownValue(row, field))), 0)) }),
    defineFunction({ name: 'RowCount', description: 'Count the bounded rows actually provided.', params: z.object({ rows: z.array(z.any()) }), returns: numeric(), fn: ({ rows: input }) => rows(input).length }),
    defineFunction({ name: 'GroupTotals', description: 'Group bounded rows by a scalar own field and sum a numeric field. Returns group and total rows.', params: z.object({ rows: z.array(z.any()), groupField: key(), valueField: key() }), returns: z.array(z.any()), fn: ({ rows: input, groupField, valueField }) => {
      const groups = new Map();
      for (const row of rows(input)) {
        const group = ownValue(row, groupField);
        if (!['string', 'number', 'boolean'].includes(typeof group)) reject('invalid_binding');
        const id = canonicalJSON(group);
        groups.set(id, { group, total: finite((groups.get(id)?.total ?? 0) + finite(ownValue(row, valueField))) });
      }
      return [...groups.values()];
    } }),
    defineFunction({ name: 'Decimal', description: 'Format a finite value with 0-6 decimal places; no implicit currency or locale.', params: z.object({ value: numeric(), places: z.number().int().min(0).max(6) }), returns: text(), fn: ({ value, places }) => finite(value).toFixed(places) }),
  ];
}

/** Builds the same specification for pure evaluation and the native Peer component adapter. */
export function createPeerLibrary({ bindings = {}, components = {} } = {}) {
  return createLibrary({
    id: LIBRARY_VERSION,
    components: Object.entries(COMPONENT_SCHEMAS).map(([name, props]) => defineComponent({ name, props, description: COMPONENT_DESCRIPTIONS[name], component: components[name] ?? null })),
    functions: functionDefinitions(bindings),
    root: 'Col',
  });
}

export function runtimeFunctions(library, budget = { remaining: L.evaluationSteps }) {
  const spec = library.toJSONSchema().functions;
  return Object.fromEntries(Object.entries(library.functions).map(([name, definition]) => [name, {
    ...spec[name], fn: args => boundedJSON(definition.fn(boundedJSON(args, { budget })), { budget }),
  }]));
}

export const catalogSpec = () => ({ version: LIBRARY_VERSION, schema: createPeerLibrary().toJSONSchema() });
