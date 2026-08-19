export const CLI_EXIT = {
  ok: 0,
  runtime: 1,
  usage: 2,
  auth: 3,
  cancelled: 4,
  maxTurns: 5,
} as const;

export type CliExitCode = (typeof CLI_EXIT)[keyof typeof CLI_EXIT];
