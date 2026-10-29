/**
 * 记忆写入前的密钥扫描。
 * 规则与 Shell 输出脱敏、协议 assessMemoryCandidate 的敏感匹配取并集。
 * 命中则整次写入拒绝，不落盘、不改成打码文本。
 */

const PROTOCOL_SECRET = /sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]{8,}/i;

const SHELL_RULES = [
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]'],
  [/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]'],
  [/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED_TOKEN]'],
  [/([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)=)[^\s]+/gi, '$1[REDACTED]'],
];

/** 命中密钥或令牌时返回 `sensitive`，否则返回 null。 */
export function memorySecretReason(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return null;
  if (PROTOCOL_SECRET.test(text)) return 'sensitive';
  let redacted = text;
  for (const [pattern, replacement] of SHELL_RULES) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted === text ? null : 'sensitive';
}
