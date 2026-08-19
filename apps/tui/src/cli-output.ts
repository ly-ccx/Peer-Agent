export interface ExecJsonResult {
  readonly sessionId: string;
  readonly ok: boolean;
  readonly result: string | null;
  readonly error: string | null;
  readonly turns: number;
  readonly durationMs: number;
  readonly usage?: unknown;
}

export function encodeExecJson(payload: ExecJsonResult): string {
  return JSON.stringify({
    sessionId: payload.sessionId,
    ok: payload.ok,
    result: payload.result,
    error: payload.error,
    turns: payload.turns,
    durationMs: payload.durationMs,
    ...(payload.usage === undefined ? {} : { usage: payload.usage }),
  });
}

export function isAuthFailureReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return /credential|oauth|api key|unauthor|401|locked|sign in|unconfigured|not configured|missing model/i
    .test(reason);
}
