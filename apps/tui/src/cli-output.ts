export interface ExecGoalStopReport {
  readonly planId: string;
  /** Final plan status observed by the exec process (completed / failed / blocked / executing ...). */
  readonly planStatus: string | null;
  /** Runner status at exit (waiting_user / blocked / paused / budget_exhausted / ...). */
  readonly runnerStatus: string | null;
  /** Machine-readable stop reason, e.g. requested_user_input / manual_dod_confirmation_required / scope_drift. */
  readonly exitReason: string | null;
  /** Human-readable blocked reason from the runner state, if any. */
  readonly blockedReason: string | null;
  /** Pending question text when the runner stopped on waiting_user, if any. */
  readonly waitingQuestion: string | null;
  /** Manual DoD criteria awaiting human confirmation, if any. */
  readonly pendingManualDoD: readonly string[];
  /** Completed/total subtasks at exit. */
  readonly progress: { readonly completed: number; readonly total: number } | null;
}

export interface ExecJsonResult {
  readonly sessionId: string;
  readonly ok: boolean;
  readonly result: string | null;
  readonly error: string | null;
  readonly turns: number;
  readonly durationMs: number;
  readonly usage?: unknown;
  /** Present only when a GoalPlan was created (and possibly driven) during this exec run. */
  readonly goal?: ExecGoalStopReport;
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
    ...(payload.goal === undefined ? {} : { goal: payload.goal }),
  });
}

export function isAuthFailureReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return /credential|oauth|api key|unauthor|401|locked|sign in|unconfigured|not configured|missing model/i
    .test(reason);
}
