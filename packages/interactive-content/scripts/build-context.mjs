import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { catalogSpec, COMPONENT_SCHEMAS } from '../src/catalog.mjs';
import { canonicalJSON } from '../src/limits.mjs';

function type(schema = {}) {
  if (schema.$ref) return 'LocalAction';
  if (schema.anyOf) return schema.anyOf.map(type).join('|');
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join('|');
  if (schema.type === 'object') return `{${params(schema).join(',')}}`;
  if (schema.type === 'array') return `${type(schema.items)}[${schema.minItems ?? 0}..${schema.maxItems ?? 500}]`;
  if (schema.pattern === '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$') return 'key';
  if (schema.type === 'string') return `string${schema.maxLength ? `[${schema.minLength ?? 0}..${schema.maxLength}]` : ''}`;
  if (['number', 'integer'].includes(schema.type)) return `${schema.type}${schema.minimum !== undefined || schema.maximum !== undefined ? `[${schema.minimum ?? '-inf'}..${schema.maximum ?? 'inf'}]` : ''}${schema.exclusiveMinimum !== undefined ? `>${schema.exclusiveMinimum}` : ''}`;
  return schema.type ?? 'JSON';
}
function params(schema) { return Object.entries(schema.properties ?? {}).map(([name, value]) => `${name}${schema.required?.includes(name) ? '' : '?'}:${type(value)}`); }
const spec = catalogSpec();
const specHash = `sha256:${createHash('sha256').update(canonicalJSON(spec)).digest('hex')}`;
const lines = [
  'Peer interactive result language (trusted catalog rules; not runtime authority).',
  `Library ${spec.version}; specHash ${specHash}.`,
  'Publish only if publish_interactive_result is projected to this worker. Inspectors never gain publish rights. This is a fixed snapshot, not a live website.',
  'DSL: one name=expression per line; root=component is required. Component arguments are positional in the order below; optional trailing arguments may be omitted. Arrays use [], objects use {key:value}. Use references by name. State defaults are $name=finiteNumber|string|boolean literals; use $name directly in each input value position. Never quote a state binding.',
  'Functions use @Name(args). Operators: + - * / % == != > < >= <= && || ! and ternary ?:; numeric operands must be numbers, never divide/modulo by zero. No loops, recursion, dynamic functions, JavaScript, HTML, CSS, URLs, imports, Query, Mutation, MCP, network, Now or Random. Only the names below exist.',
  'key means /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/. All numbers are finite IEEE754; specify units. Decimal uses 0..6 decimal places. Layout children contain only registered elements. IDs and table row keys must be stable and unique. Chart xKey values are unique; series values are numeric.',
  'Components:',
  ...Object.keys(COMPONENT_SCHEMAS).map(name => `${name}(${params(spec.schema.$defs[name]).join(',')}) — ${spec.schema.$defs[name].description}`),
  'Pure functions (bounded rows, own fields only):',
  ...Object.entries(spec.schema.functions).map(([name, value]) => `@${name}(${params(value.params).join(',')}) -> ${type(value.returns)} — ${value.description}`),
  'LocalAction: @Set($declaredState,expression), @Reset($declaredState,...), or @Action([these actions]). Set/Reset cannot call tools, send messages, write project files or modify data bindings. Do not use permission/grant/evidence/taskstatus/executionstatus/accepted/approval as state names.',
  'Limits: program 64KiB; fallback 32KiB; input snapshots total 512KiB, <=16 bindings; AST <=1000 nodes/depth24; expanded elements <=300/depth12; state <=64 fields/64KiB; strings <=8192 chars; collections <=500; table <=20 columns, local pages <=100 rows/1000 cells; chart <=6 series/500 total points. Pure evaluation has a shared 40000-step budget; do not multiply expensive nested computations.',
  'Materials: copy host interactiveMaterial.source from actual Tool Results (payload/json), or an admitted fixed user-material reference from L7 context (text/json); choose bounded fields/rows. @Data requires an existing literal bindingId. Keep exact source version/classification/redaction/truncation; no file reread, preview padding or fabricated Evidence. model-data is always an assumption/example. Missing canonical data requires an ordinary governed read or honest text fallback.',
  'Publication: explicit create, or revise with an admitted owner/resultId/contentVersion base. Same call ID always has identical parameters; use a new ID only for a known noncommitted corrected candidate. At most two content repairs after the initial validation failure, within the original work budget. Pending/unknown means inspect the original publication target, never replay with another ID. Version conflict never auto-rebases or creates a substitute result.',
  'inspect_interactive_result: main Bot metadata/text only; worker/Verifier may read fixed program, selected bindings and bounded evaluation. Evaluation uses validated initial values, or an explicitly admitted frozen user followup; never latest UI state. Publish/read/compute Evidence proves those operations, not source business truth, verification or acceptance.',
  'Example (model assumption; inputs=[]):',
  '$budget=100\nroot=Col([Title("Estimate"),NumberInput("budget","Budget",$budget,0,10000,1),Metric("Double",$budget*2,"USD"),Button("Reset",@Reset($budget))])',
];
const content = lines.join('\n');
if (Buffer.byteLength(content) > 16 * 1024) throw Error('interactive_context_byte_budget');
const generated = { libraryVersion: spec.version, specHash, componentNames: Object.keys(COMPONENT_SCHEMAS), functionNames: Object.keys(spec.schema.functions), content };
writeFileSync(new URL('../src/context.generated.mjs', import.meta.url), '// Generated from the public Peer catalog by scripts/build-context.mjs. No SDK import at runtime.\nexport const INTERACTIVE_CONTEXT = Object.freeze(' + JSON.stringify(generated, null, 2) + ');\n');
