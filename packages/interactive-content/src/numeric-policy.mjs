import { evaluate } from '@openuidev/lang-core';
import { INTERACTIVE_LIMITS as L, reject } from './limits.mjs';

/** SDK arithmetic coerces invalid operands and divides by zero to 0. Check its public AST first. */
export function checkNumericExpressions(declarations, values, functions) {
  let steps = 0;
  const memo = new Map();
  const context = { getState: key => values[key], functions, resolveRef: name => {
    if (!declarations.has(name)) reject('invalid_reference');
    if (!memo.has(name)) memo.set(name, evaluate(declarations.get(name), context));
    return memo.get(name);
  }, reportError: () => reject('evaluation_failed') };
  const number = value => { if (typeof value !== 'number' || !Number.isFinite(value)) reject('non_finite_value'); return value; };
  const checked = new Set();
  function visit(node) {
    if (++steps > L.evaluationSteps) reject('resource_limit');
    if (node.k === 'Ref') {
      if (!checked.has(node.n)) { checked.add(node.n); visit(declarations.get(node.n)); }
      return;
    }
    if (node.k === 'Ternary') {
      visit(node.cond);
      const condition = evaluate(node.cond, context);
      if (typeof condition !== 'boolean') reject('invalid_condition');
      visit(condition ? node.then : node.else); return;
    }
    if (node.k === 'BinOp') {
      visit(node.left);
      const left = evaluate(node.left, context);
      if (node.op === '&&' || node.op === '||') {
        if (typeof left !== 'boolean') reject('invalid_condition');
        if (node.op === '&&' ? left : !left) {
          visit(node.right);
          if (typeof evaluate(node.right, context) !== 'boolean') reject('invalid_condition');
        }
        return;
      }
      visit(node.right);
      const right = evaluate(node.right, context);
      if (node.op === '==' || node.op === '!=') {
        if (typeof left !== typeof right) reject('invalid_comparison');
      } else if (!(node.op === '+' && typeof left === 'string' && typeof right === 'string')) {
        number(left); number(right);
        if ((node.op === '/' || node.op === '%') && right === 0) reject('division_by_zero');
      }
      const result = evaluate(node, context);
      if (typeof result === 'number') number(result);
      if (typeof result === 'string' && result.length > L.textChars) reject('resource_limit');
      return;
    }
    if (node.k === 'UnaryOp') {
      visit(node.operand);
      const value = evaluate(node.operand, context);
      if (node.op === '!') { if (typeof value !== 'boolean') reject('invalid_condition'); }
      else number(value);
      return;
    }
    const children = node.k === 'Comp' ? node.args : node.k === 'Arr' ? node.els : node.k === 'Obj' ? node.entries.map(([, value]) => value)
      : node.k === 'Member' ? [node.obj] : node.k === 'Index' ? [node.obj, node.index] : [];
    children.forEach(visit);
  }
  for (const node of declarations.values()) visit(node);
}
