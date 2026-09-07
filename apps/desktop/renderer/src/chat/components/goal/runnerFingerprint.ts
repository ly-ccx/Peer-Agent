/** Compare displayed runner state across store and runner event channels. */
export function runnerFingerprint(runner: object | null | undefined): string {
  if (!runner) return '';
  const r = runner as Record<string, unknown>;
  return JSON.stringify([
    r.status ?? '', r.phase ?? '', r.enabled ?? '',
    r.roundCount ?? '', r.toolCallCount ?? '', r.intent ?? '',
    r.currentTaskId ?? '', r.lastTickAt ?? '', r.lastError ?? '',
    r.blockedReason ?? '', r.explorerCount ?? '',
    r.explorerBatch ?? null, r.explorers ?? [],
  ]);
}
