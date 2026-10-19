import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const version = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
/** Read-only recovery UI facts. The recovery command still reads the original checkpoint. */
export function createRecoveryCheckpointView(directory) {
  return createCheckpointProjection(directory, checkpoint => {
    const outcome = checkpoint?.outcome;
    return checkpoint && typeof checkpoint === 'object' ? {
      ...(checkpoint.job ? { job: { workId: checkpoint.job.workId } } : {}),
      ...(outcome ? { outcome: { failed: outcome.failed, yielded: outcome.yielded, stopped: outcome.stopped,
        providerCheckpoint: Boolean(outcome.providerCheckpoint),
        rounds: (outcome.rounds || []).map(round => ({ toolCalls: (round.toolCalls || []).map(call => ({
          ...(call.result !== undefined ? { result: true } : {}),
        })) })) } } : {}),
    } : null;
  });
}

/** Discovery only. A selected continuation must still load its full protected checkpoint. */
export function createContinuationCheckpointView(directory) {
  return createCheckpointProjection(directory, checkpoint => ({ job: checkpoint?.job ? {
    workId: checkpoint.job.workId, kind: checkpoint.job.kind, interactive: checkpoint.job.interactive,
    userInputs: checkpoint.job.userInputs?.map(input => ({ inputId: input.inputId, createdAt: input.createdAt })),
    events: checkpoint.job.events?.map(event => ({ eventId: event.eventId, kind: event.kind, sessionId: event.sessionId })),
  } : undefined }));
}

function createCheckpointProjection(directory, project) {
  const cache = new Map();
  let bytes = 0;
  const drop = ref => { const row = cache.get(ref); if (row) bytes -= row.bytes; cache.delete(ref); };
  return ref => {
    if (!/^[a-f0-9]{64}\.json$/.test(ref || '')) throw new Error('invalid_checkpoint');
    const file = path.join(directory, ref);
    try {
      const token = version(statSync(file, { bigint: true }));
      let row = cache.get(ref);
      if (row?.token !== token) {
        const checkpoint = JSON.parse(readFileSync(file, 'utf8'));
        if (version(statSync(file, { bigint: true })) !== token) throw new Error('checkpoint_read_changed');
        const value = project(checkpoint);
        row = { token, value, bytes: Buffer.byteLength(JSON.stringify(value) ?? 'null') };
      }
      drop(ref);
      if (row.bytes <= 8 * 1024 * 1024) {
        cache.set(ref, row); bytes += row.bytes;
        while (cache.size > 64 || bytes > 8 * 1024 * 1024) drop(cache.keys().next().value);
      }
      return structuredClone(row.value);
    } catch (error) { drop(ref); throw error; }
  };
}
