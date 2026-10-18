import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const version = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
/** Read-only recovery UI facts. The recovery command still reads the original checkpoint. */
export function createRecoveryCheckpointView(directory) {
  const cache = new Map();
  return ref => {
    if (!/^[a-f0-9]{64}\.json$/.test(ref || '')) throw new Error('invalid_checkpoint');
    const file = path.join(directory, ref);
    try {
      const token = version(statSync(file, { bigint: true }));
      let row = cache.get(ref);
      if (row?.token !== token) {
        const checkpoint = JSON.parse(readFileSync(file, 'utf8'));
        if (version(statSync(file, { bigint: true })) !== token) throw new Error('checkpoint_read_changed');
        const outcome = checkpoint?.outcome;
        const value = checkpoint && typeof checkpoint === 'object' ? {
          ...(checkpoint.job ? { job: { workId: checkpoint.job.workId } } : {}),
          ...(outcome ? { outcome: { failed: outcome.failed, yielded: outcome.yielded, stopped: outcome.stopped,
            providerCheckpoint: Boolean(outcome.providerCheckpoint),
            rounds: (outcome.rounds || []).map(round => ({ toolCalls: (round.toolCalls || []).map(call => ({
              ...(call.result !== undefined ? { result: true } : {}),
            })) })) } } : {}),
        } : null;
        row = { token, value };
      }
      cache.delete(ref); cache.set(ref, row);
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      return structuredClone(row.value);
    } catch (error) { cache.delete(ref); throw error; }
  };
}
