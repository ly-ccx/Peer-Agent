/** Separate a transaction failure from a lost confirmation after the transaction returned. */
export function withCleanupOutcome(storage, workspaceId, work) {
  let committed = false;
  const commit = mutate => {
    const receipt = storage.transaction(workspaceId, mutate);
    committed = true;
    return receipt;
  };
  try {
    return work(commit);
  } catch (cause) {
    if (!committed) throw cause;
    const code = 'interactive_cleanup_outcome_unknown';
    throw Object.assign(new Error(code, { cause }), { code });
  }
}
