import type { ProjectAgentToolPreview } from './project.ts';

const PRIVATE_FIELD = /(?:api.?key|token|secret|password|credential|authorization|cookie|private.?key|reasoning|thinking)/i;

/** One bounded display seam for tool parameters/results in live and historical presentation. It never executes a tool. */
export function toolActivityPreview(value: unknown, limit: number): ProjectAgentToolPreview {
  if (typeof value === 'string' && value.length > 64_000) return { text: '', truncated: true, redacted: true };
  let redacted = false, truncated = false, nodes = 0;
  const cleanText = (text: string) => {
    const bounded = text.slice(0, 6000);
    if (bounded.length < text.length) truncated = true;
    const clean = bounded
      .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
      .replace(/AKIA[0-9A-Z]{16}/g, '[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
      .replace(/((?:api[_-]?key|token|secret|password|authorization|cookie)\s*["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, '$1[redacted]')
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/g, '[redacted]');
    if (clean !== bounded) redacted = true;
    return clean;
  };
  const visit = (item: unknown, depth = 0): unknown => {
    if (++nodes > 160 || depth > 6) { truncated = true; return '[truncated]'; }
    if (typeof item === 'string') return cleanText(item);
    if (item == null || typeof item === 'boolean' || typeof item === 'number') return item;
    if (Array.isArray(item)) {
      if (item.length > 40) truncated = true;
      return item.slice(0, 40).map(child => visit(child, depth + 1));
    }
    if (typeof item === 'object') {
      const fields: [string, unknown][] = [];
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (fields.length >= 40) { truncated = true; break; }
        if (PRIVATE_FIELD.test(key)) { redacted = true; fields.push([key, '[redacted]']); }
        else fields.push([cleanText(key), visit((item as Record<string, unknown>)[key], depth + 1)]);
      }
      return Object.fromEntries(fields);
    }
    return String(item);
  };
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { /* Plain terminal/file output. */ } }
  const clean = visit(parsed);
  const text = typeof clean === 'string' ? clean : JSON.stringify(clean ?? null, null, 2);
  return { text: text.slice(0, limit), truncated: truncated || text.length > limit, redacted };
}

export function toolActivitySummary(input: Readonly<Record<string, unknown>> | null | undefined): string {
  const value = input?.path ?? input?.command ?? input?.cmd ?? input?.query ?? input?.title;
  return typeof value === 'string' ? toolActivityPreview(value.replace(/\s+/g, ' ').trim(), 160).text : '';
}
