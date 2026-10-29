/** Canonical host responses remain external data until the renderer parses them. */
export function readWithdrawnTaskSnapshots(): Promise<{
  readonly pending: readonly unknown[];
  readonly withdrawn: readonly unknown[];
  readonly recovered: readonly unknown[];
}>;
