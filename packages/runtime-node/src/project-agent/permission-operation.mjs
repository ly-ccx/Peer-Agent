import { createHash } from 'node:crypto';

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** Stable parameter digest shared by audit records and executable authority. */
export function digestApprovalArgs(args) {
  let encoded = '"unserializable"';
  try { encoded = stableStringify(args ?? null); } catch { /* fail to match normal operations */ }
  return createHash('sha256').update(encoded).digest('hex');
}
