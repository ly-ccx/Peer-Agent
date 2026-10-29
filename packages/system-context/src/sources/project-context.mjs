import { neutralizeToolCallSyntax } from '../sanitize-context-text.mjs';

const SECRET = /sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]{8,}/i;

export function turnBag(input) {
  const bag = input?.turnContext;
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return {};
  return bag;
}

export function hasRole(input, role) {
  return input?.role === role;
}

export function clipText(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const safe = neutralizeToolCallSyntax(trimmed);
  if (safe.length <= max) return safe;
  return `${safe.slice(0, Math.max(0, max - 1))}…`;
}

export function looksSensitive(value) {
  return typeof value === 'string' && SECRET.test(value);
}

export function firstArray(...candidates) {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}
