/** A process-wide resource owner: index rebuilds wait FIFO without starting a Worker. */
export function createCoordinationRebuildQueue(concurrency = 4) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('invalid_rebuild_concurrency');
  const pending = [];
  let active = 0;
  function drain() {
    while (active < concurrency && pending.length) {
      const { run, resolve, reject } = pending.shift();
      active++;
      Promise.resolve().then(run).then(resolve, reject).finally(() => { active--; drain(); });
    }
  }
  return run => new Promise((resolve, reject) => { pending.push({ run, resolve, reject }); drain(); });
}

export const withCoordinationRebuild = createCoordinationRebuildQueue();
