/** Session/selection generations prevent late IPC results from mutating a newer composer. */
export function createSelectionRequestGate() {
  let generation = 0;
  let pending = false;
  return {
    invalidate() { generation += 1; pending = false; },
    begin() {
      if (pending) return null;
      pending = true;
      const started = generation;
      let finished = false;
      return {
        isCurrent: () => !finished && started === generation,
        finish() {
          if (finished || started !== generation) return false;
          finished = true;
          pending = false;
          return true;
        },
      };
    },
  };
}
