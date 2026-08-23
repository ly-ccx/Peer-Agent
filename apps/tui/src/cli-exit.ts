export const CLI_EXIT = {
  ok: 0,
  runtime: 1,
  usage: 2,
  auth: 3,
  cancelled: 4,
  maxTurns: 5,
  /** Goal Runner stopped on a path that requires human input (waiting_user / blocked / paused / budget_exhausted). */
  waitingUser: 6,
  /** Goal plan reached terminal status "failed". */
  goalFailed: 7,
} as const;

export type CliExitCode = (typeof CLI_EXIT)[keyof typeof CLI_EXIT];
