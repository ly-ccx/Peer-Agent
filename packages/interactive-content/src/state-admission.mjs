import { boundedJSON, INTERACTIVE_LIMITS as L, reject } from './limits.mjs';

const CREDENTIAL_FIELD = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|secret[_-]?access[_-]?key)$/i;
const CREDENTIAL_TEXT = [
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,})/,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|aws_secret_access_key|[A-Z][A-Z0-9_]*_(?:TOKEN|SECRET|PASSWORD))\s*=\s*[^\s]+/i,
  /(?:^|[{,\s])["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*:\s*["']?[^"'\s,}]+/i,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/i,
  /[?&](?:api[_-]?key|access[_-]?token|token|password|secret)=[^&#\s]+/i,
];
const protectedState = () => reject('interactive_state_protected');

function nativePayload(value) {
  return typeof value.grantId === 'string' && (typeof value.granted === 'boolean' && typeof value.toolCallId === 'string'
      || typeof value.capabilityId === 'string' && typeof value.decision === 'string')
    || typeof value.granted === 'boolean' && value.scope && typeof value.scope === 'object'
    || typeof value.approvalId === 'string' && typeof value.capabilityId === 'string' && typeof value.argsDigest === 'string'
    || value.kind === 'capability-approval' && typeof value.approvalKind === 'string'
    || typeof value.viewId === 'string' && typeof value.generation === 'string' && typeof value.token === 'string';
}

/** Bounded, I/O-free admission of recognizable protected formats; never returns matched bytes. */
export function assertStateMaterial(value) {
  let remaining = L.evaluationSteps;
  function visit(current, depth = 0) {
    if (--remaining < 0 || depth > 16) reject('resource_limit');
    if (typeof current === 'string') {
      if (CREDENTIAL_TEXT.some(pattern => pattern.test(current))) protectedState();
      const text = current.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/i, '$1').trim();
      if (!text.startsWith('{') && !text.startsWith('[') && !text.startsWith('"')) return;
      let parsed;
      try { parsed = JSON.parse(text); } catch { return; }
      // Parsing a string never grants authority, even when its object shape resembles native data.
      visit(boundedJSON(parsed, { maxBytes: L.stateBytes, maxItems: L.collectionItems }), depth + 1);
    } else if (Array.isArray(current)) current.forEach(item => visit(item, depth + 1));
    else if (current && typeof current === 'object') {
      if (nativePayload(current)) protectedState();
      for (const [key, item] of Object.entries(current)) {
        if (CREDENTIAL_FIELD.test(key) && typeof item === 'string' && item.trim()) protectedState();
        visit(item, depth + 1);
      }
    }
  }
  visit(value);
}
