/** The structured observation shared by Conversation and Work. */
export function isHookObservation(
  input: unknown, event: unknown, ruleDigest: string, handleId: unknown,
): boolean {
  const note = (value: unknown) => typeof value === 'string'
    && new TextEncoder().encode(value).length <= 1024
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return Object.keys(value).length === 10
    && value.event === event && value.ruleDigest === ruleDigest && value.handleId === handleId
    && ['allow', 'ask', 'deny'].some(decision => decision === value.decision)
    && typeof value.outcome === 'string' && value.outcome.length > 0
    && new TextEncoder().encode(value.outcome).length <= 128
    && (value.exitCode === null || typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)
      && value.exitCode >= -2147483648 && value.exitCode <= 2147483647)
    && Number.isSafeInteger(value.durationMs) && (value.durationMs as number) >= 0
    && note(value.id) && value.hookId === value.id
    && (value.reason === null || note(value.reason));
}
