import { tokenize } from '@openuidev/lang-core';
import { reject } from './limits.mjs';

// This is a printer for the admitted public AST, not a second parser/evaluator.
// Comparing its public tokens proves that permissive parsing did not drop a
// trailing identifier, literal, separator or operator. Redundant grouping is allowed.
function print(node) {
  const nested = child => `(${print(child)})`;
  switch (node.k) {
    case 'Str': return JSON.stringify(node.v);
    case 'Num': return String(node.v);
    case 'Bool': return node.v ? 'true' : 'false';
    case 'Null': return 'null';
    case 'Ref': case 'StateRef': return node.n;
    case 'Arr': return `[${node.els.map(print).join(',')}]`;
    case 'Obj': return `{${node.entries.map(([key, value]) => `${JSON.stringify(key)}:${print(value)}`).join(',')}}`;
    case 'Comp': return `${node.fn ? '@' : ''}${node.name}(${node.args.map(print).join(',')})`;
    case 'BinOp': return `${nested(node.left)}${node.op}${nested(node.right)}`;
    case 'UnaryOp': return `${node.op}${nested(node.operand)}`;
    case 'Ternary': return `${nested(node.cond)}?${nested(node.then)}:${nested(node.else)}`;
    case 'Member': return `${nested(node.obj)}.${node.field}`;
    case 'Index': return `${nested(node.obj)}[${print(node.index)}]`;
    default: reject('unsupported_node');
  }
}
function signature(tokens) {
  return tokens.filter(token => ![0, 1, 2, 13].includes(token.t)).map(token => [
    // The public AST normalizes quoted/bare object keys. Identifiers and strings
    // still retain their exact value and position; every token must be accounted for.
    [14, 16, 17, 18, 35].includes(token.t) ? 'name' : token.t, token.v ?? null,
  ]);
}
export function assertExpressionCoverage(tokens, ast) {
  if (JSON.stringify(signature(tokens)) !== JSON.stringify(signature(tokenize(print(ast))))) reject('unconsumed_syntax');
}
