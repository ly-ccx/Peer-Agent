const MAX_PREVIEW_CHARS = 4_000;

export function truncatePreview(value, maxChars = MAX_PREVIEW_CHARS) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[preview truncated]`;
}

export function redactShellOutput(value) {
  const text = truncatePreview(value);
  return text
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)=)[^\s]+/gi, '$1[REDACTED]');
}

export function outputRedactions(stdout, stderr, redactedStdout, redactedStderr) {
  const redactions = [];
  if (String(stdout ?? '') !== redactedStdout || String(stderr ?? '') !== redactedStderr) {
    redactions.push('secret_like_tokens');
  }
  if (String(stdout ?? '').length > MAX_PREVIEW_CHARS || String(stderr ?? '').length > MAX_PREVIEW_CHARS) {
    redactions.push('preview_truncated');
  }
  return [...new Set(redactions)];
}
