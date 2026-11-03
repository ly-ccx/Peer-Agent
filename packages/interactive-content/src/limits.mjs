import { INTERACTIVE_RESULT_LIMITS } from '@peer-agent/protocol';
export const INTERACTIVE_LIMITS = INTERACTIVE_RESULT_LIMITS;

export const LIBRARY_VERSION = 'peer-basic-1';
export const ENGINE_VERSION = 'openui-lang-core-1.0.0';
export const CONTENT_SCHEMA_VERSION = 1;
export const utf8Bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : canonicalJSON(value)).byteLength;
export const forbiddenKey = value => ['__proto__', 'prototype', 'constructor'].includes(value);
export const stateKey = value => typeof value === 'string' && /^\$[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(value) && !forbiddenKey(value.slice(1));

export class InteractiveContentError extends Error {
  constructor(code, path = '', details = '') {
    super(code);
    this.name = 'InteractiveContentError';
    this.code = code;
    this.path = String(path).slice(0, 240);
    this.details = String(details).slice(0, 240);
  }
}
export function reject(code, path = '', details = '') { throw new InteractiveContentError(code, path, details); }

/** Stable bytes shared by browser, Node and Bun; no prototype or executable values. */
export function canonicalJSON(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject('non_finite_value');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject('invalid_json');
  return `{${Object.keys(value).sort().map(key => {
    if (forbiddenKey(key)) reject('reserved_key', key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) reject('invalid_json', key);
    return `${JSON.stringify(key)}:${canonicalJSON(descriptor.value)}`;
  }).join(',')}}`;
}

export function boundedJSON(value, { maxBytes = INTERACTIVE_LIMITS.inputBytes, maxItems = INTERACTIVE_LIMITS.collectionItems, maxDepth = 16, maxStringChars = INTERACTIVE_LIMITS.textChars, budget } = {}) {
  let visited = 0;
  const seen = new Set();
  function visit(current, depth) {
    if (++visited > INTERACTIVE_LIMITS.evaluationSteps || depth > maxDepth) reject('resource_limit');
    // One evaluation shares this counter across all pure functions and row
    // materialization. Long strings are work too, even when row counts are small.
    if (budget && (budget.remaining -= 1 + (typeof current === 'string' ? Math.ceil(current.length / 64) : 0)) < 0) reject('resource_limit', '', 'evaluation_steps');
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'number') { if (!Number.isFinite(current)) reject('non_finite_value'); return; }
    if (typeof current === 'string') { if (current.length > maxStringChars) reject('resource_limit'); return; }
    if (!current || typeof current !== 'object' || seen.has(current)) reject('invalid_json');
    if (!Array.isArray(current) && ![Object.prototype, null].includes(Object.getPrototypeOf(current))) reject('invalid_json');
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > maxItems) reject('resource_limit');
      for (let index = 0; index < current.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !('value' in descriptor)) reject('invalid_json');
        visit(descriptor.value, depth + 1);
      }
    } else {
      if (Object.keys(current).length > maxItems) reject('resource_limit');
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
        if (forbiddenKey(key) || key.length > 128 || !('value' in descriptor)) reject('reserved_key', key);
        visit(descriptor.value, depth + 1);
      }
    }
    seen.delete(current);
  }
  visit(value, 0);
  if (utf8Bytes(value) > maxBytes) reject('resource_limit');
  return JSON.parse(canonicalJSON(value));
}
