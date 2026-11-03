import { autoClose, parseExpression, split, tokenize } from '@openuidev/lang-core';
import { COMPONENT_SCHEMAS } from './catalog.mjs';
import { INTERACTIVE_LIMITS as L, forbiddenKey, reject, stateKey, utf8Bytes } from './limits.mjs';
import { assertExpressionCoverage } from './syntax-policy.mjs';

export const FUNCTION_NAMES = Object.freeze(['Data', 'RowsWhere', 'Total', 'RowCount', 'GroupTotals', 'Decimal']);
const FUNCTIONS = new Set(FUNCTION_NAMES);
const ACTIONS = new Set(['Set', 'Reset', 'Action']);
const RESERVED = new Set([...Object.keys(COMPONENT_SCHEMAS), ...FUNCTIONS, ...ACTIONS]);
const OPS = new Set(['+', '-', '*', '/', '%', '==', '!=', '>', '<', '>=', '<=', '&&', '||']);
const GOVERNANCE_STATE = new Set(['permission', 'grant', 'evidence', 'taskstatus', 'executionstatus', 'accepted', 'approval']);
const AST_KINDS = new Set(['Comp', 'Str', 'Num', 'Bool', 'Null', 'Arr', 'Obj', 'Ref', 'Ph', 'StateRef', 'RuntimeRef', 'BinOp', 'UnaryOp', 'Ternary', 'Member', 'Index', 'Assign']);

/** The SDK treats structural AST/element markers specially even inside plain JSON. */
export function rejectEngineData(value) {
  if (!value || typeof value !== 'object') return;
  if (AST_KINDS.has(value.k) || value.type === 'element' || Object.hasOwn(value, '__reactive')) reject('invalid_data_marker');
  for (const child of Object.values(value)) rejectEngineData(child);
}

/** Policy over the SDK's public tokens/AST, before parser materialization or evaluation. */
export function inspectProgram(program, bindings) {
  if (typeof program !== 'string' || !program.trim() || utf8Bytes(program) > L.programBytes) reject('resource_limit', 'program');
  if (autoClose(program).wasIncomplete) reject('incomplete_program');
  const tokens = tokenize(program);
  if (tokens.length > L.astNodes * 8) reject('resource_limit');
  let nesting = 0;
  // Reject forbidden/unknown calls even when the permissive SDK would skip a line.
  let previous;
  for (const token of tokens) {
    if (token.t === 1 && previous && ![0, 1, 3, 5, 7, 8, 9, 17, 35].includes(previous.t)
      && !(previous.t >= 20 && previous.t <= 34)) reject('invalid_program');
    if ([1, 3, 5].includes(token.t) && ++nesting > L.astDepth) reject('resource_limit');
    if ([2, 4, 6].includes(token.t) && --nesting < 0) reject('invalid_program');
    if ((token.t === 17 || token.t === 35) && !RESERVED.has(token.v)) reject('unsupported_node', '', String(token.v));
    if ((token.t === 16 || token.t === 17 || token.t === 18) && forbiddenKey(String(token.v).replace(/^\$/, ''))) reject('reserved_key');
    if (token.t === 15 && !Number.isFinite(token.v)) reject('non_finite_value');
    previous = token;
  }
  const statements = split(tokens);
  if (!statements.length || statements.length > L.astNodes) reject('invalid_program');
  const covered = statements.reduce((sum, row) => sum + row.tokens.length + 2, 0);
  if (covered !== tokens.filter(token => ![0, 13].includes(token.t)).length) reject('invalid_program');
  const declarations = new Map(), defaults = {};
  for (const row of statements) {
    if (declarations.has(row.id) || RESERVED.has(row.id) || forbiddenKey(row.id)) reject('reserved_declaration', row.id);
    const ast = parseExpression(row.tokens);
    if (row.id.startsWith('$')) {
      if (!stateKey(row.id) || GOVERNANCE_STATE.has(row.id.slice(1).toLowerCase()) || !['Str', 'Num', 'Bool'].includes(ast.k)) reject('invalid_state_declaration', row.id);
      defaults[row.id] = ast.v;
    }
    declarations.set(row.id, ast);
  }
  if (!declarations.has('root') || Object.keys(defaults).length > L.stateFields) reject('invalid_program');
  let nodes = 0;
  const refs = new Map();
  function visit(node, depth, statementId, action = false) {
    if (!node || ++nodes > L.astNodes || depth > L.astDepth) reject('resource_limit', statementId);
    const nested = child => visit(child, depth + 1, statementId);
    if (action) {
      if (node.k !== 'Comp' || !ACTIONS.has(node.name)) reject('unsupported_action', statementId);
      if (node.name === 'Action') {
        if (node.args.length !== 1 || node.args[0].k !== 'Arr' || node.args[0].els.length > 16) reject('unsupported_action');
        for (const step of node.args[0].els) visit(step, depth + 1, statementId, true);
      } else {
        if (node.name === 'Set' && node.args.length !== 2 || node.name === 'Reset' && !node.args.length) reject('unsupported_action');
        const targets = node.name === 'Set' ? node.args.slice(0, 1) : node.args;
        for (const target of targets) if (target.k !== 'StateRef' || !Object.hasOwn(defaults, target.n)) reject('invalid_state');
        if (node.name === 'Set') nested(node.args[1]);
      }
      return;
    }
    switch (node.k) {
      case 'Str': if (node.v.length > L.textChars) reject('resource_limit'); return;
      case 'Num': if (!Number.isFinite(node.v)) reject('non_finite_value'); return;
      case 'Bool': case 'Null': return;
      case 'Arr': if (node.els.length > L.collectionItems) reject('resource_limit'); node.els.forEach(nested); return;
      case 'Obj':
        if (node.entries.length > L.collectionItems || new Set(node.entries.map(([key]) => key)).size !== node.entries.length) reject('invalid_json');
        for (const [key, child] of node.entries) {
          if (forbiddenKey(key) || key === '__reactive' || key === 'k' && (child.k !== 'Str' || AST_KINDS.has(child.v))
            || key === 'type' && (child.k !== 'Str' || child.v === 'element')) reject('reserved_key');
          nested(child);
        }
        return;
      case 'Ref':
        if (!declarations.has(node.n) || node.n.startsWith('$')) reject('invalid_reference', node.n);
        refs.set(statementId, [...(refs.get(statementId) ?? []), node.n]); return;
      case 'StateRef': if (!Object.hasOwn(defaults, node.n)) reject('invalid_state', node.n); return;
      case 'BinOp': if (!OPS.has(node.op)) reject('unsupported_node'); nested(node.left); nested(node.right); return;
      case 'UnaryOp': if (!['!', '-'].includes(node.op)) reject('unsupported_node'); nested(node.operand); return;
      case 'Ternary': nested(node.cond); nested(node.then); nested(node.else); return;
      case 'Member': if (forbiddenKey(node.field)) reject('reserved_key'); nested(node.obj); return;
      case 'Index':
        if (!['Str', 'Num'].includes(node.index.k) || node.index.k === 'Str' && forbiddenKey(node.index.v)
          || node.index.k === 'Num' && (!Number.isSafeInteger(node.index.v) || node.index.v < 0 || node.index.v >= L.collectionItems)) reject('unsupported_index');
        nested(node.obj); nested(node.index); return;
      case 'Comp': {
        const component = Object.hasOwn(COMPONENT_SCHEMAS, node.name);
        if (!component && !FUNCTIONS.has(node.name) || component && node.fn || !component && !node.fn) reject('unsupported_node', statementId, node.name);
        if (node.name === 'Data' && (node.args.length !== 1 || node.args[0].k !== 'Str' || !Object.hasOwn(bindings, node.args[0].v))) reject('invalid_binding');
        if (node.name === 'SourceReference' && (node.args[0]?.k !== 'Str' || !Object.hasOwn(bindings, node.args[0].v))) reject('invalid_binding');
        if (component && ['Input', 'NumberInput', 'Select', 'Checkbox', 'Slider'].includes(node.name) && node.args[2]?.k !== 'StateRef') reject('invalid_state_binding');
        node.args.forEach((arg, index) => visit(arg, depth + 1, statementId, node.name === 'Button' && index === 1));
        return;
      }
      default: reject('unsupported_node', statementId, node.k);
    }
  }
  for (const [id, ast] of declarations) visit(ast, 0, id);
  for (const row of statements) assertExpressionCoverage(row.tokens, declarations.get(row.id));
  // SDK materialization inlines references. Bound their expanded size before it runs.
  const weights = new Map(), active = new Set();
  function weight(id) {
    if (active.has(id)) reject('cyclic_reference', id);
    if (weights.has(id)) return weights.get(id);
    active.add(id);
    let value = 1;
    for (const ref of refs.get(id) ?? []) { value += weight(ref); if (value > L.astNodes * 4) reject('resource_limit'); }
    active.delete(id); weights.set(id, value); return value;
  }
  for (const id of declarations.keys()) weight(id);
  // Count every expanded AST node, including repeated reference edges and function costs.
  let expanded = 0, componentCount = 0, evaluationCost = 0;
  function expand(node, depth) {
    if (++expanded > L.astNodes * 4 || depth > L.astDepth) reject('resource_limit');
    if (node.k === 'Ref') { expand(declarations.get(node.n), depth + 1); return; }
    if (node.k === 'Comp') {
      if (Object.hasOwn(COMPONENT_SCHEMAS, node.name) && ++componentCount > L.expandedNodes) reject('resource_limit');
      if (FUNCTIONS.has(node.name)) evaluationCost += L.collectionItems;
    }
    if (++evaluationCost > L.evaluationSteps) reject('resource_limit');
    const children = node.k === 'Comp' ? node.args : node.k === 'Arr' ? node.els : node.k === 'Obj' ? node.entries.map(([, value]) => value)
      : node.k === 'BinOp' ? [node.left, node.right] : node.k === 'UnaryOp' ? [node.operand] : node.k === 'Ternary' ? [node.cond, node.then, node.else]
        : node.k === 'Member' ? [node.obj] : node.k === 'Index' ? [node.obj, node.index] : [];
    children.forEach(child => expand(child, depth + 1));
  }
  for (const ast of declarations.values()) expand(ast, 0);
  return { declarations, defaults, nodes, expanded, evaluationCost };
}
