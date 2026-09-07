import { mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { selectionTextHash } from './selection-reference.mjs';

function reject(code, cause) { throw Object.assign(new Error(code, { cause }), { code }); }
function verify(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || typeof snapshot.contentHash !== 'string') {
    reject('BACKGROUND_SNAPSHOT_INVALID');
  }
  const { contentHash, ...data } = snapshot;
  if (selectionTextHash(JSON.stringify(data)) !== contentHash) reject('BACKGROUND_SNAPSHOT_CORRUPT');
  return snapshot;
}

/** Internal storage primitive. Callers must authorize reads and provide validated
 * background data. Hashes detect corruption, not authenticity or permission.
 * Immutable publication uses a hard link: readers never see a partial document.
 */
export function createBackgroundSnapshotStore(directory) {
  const file = (id) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) reject('BACKGROUND_SNAPSHOT_ID_INVALID');
    return join(directory, `${id}.json`);
  };
  function read(id) {
    const target = file(id);
    let text;
    try { text = readFileSync(target, 'utf8'); }
    catch (error) { reject(error.code === 'ENOENT' ? 'BACKGROUND_SNAPSHOT_MISSING' : 'BACKGROUND_SNAPSHOT_READ_FAILED', error); }
    let snapshot;
    try { snapshot = JSON.parse(text); }
    catch (error) { reject('BACKGROUND_SNAPSHOT_CORRUPT', error); }
    verify(snapshot);
    if (snapshot.contentHash !== id) reject('BACKGROUND_SNAPSHOT_CORRUPT');
    return snapshot;
  }
  function put(snapshot) {
    // Serialize first to detach caller-owned data and reject non-JSON values.
    const serialized = JSON.stringify(snapshot);
    const detached = verify(JSON.parse(serialized));
    const target = file(detached.contentHash);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.pending-${randomUUID()}`);
    try {
      writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
      try { linkSync(temporary, target); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Existing corrupt content must not be silently overwritten.
        read(detached.contentHash);
      }
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return detached.contentHash;
  }
  return { put, read };
}
