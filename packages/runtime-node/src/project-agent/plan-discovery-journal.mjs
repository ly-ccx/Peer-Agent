import { openSync, closeSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

const token = info => info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : 'missing';
const identity = info => info ? `${info.dev}:${info.ino}` : 'missing';
function stat(file) {
  try { return statSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Invalidation hints only. Never returns plans or decides execution/permission state.
 * Governed writers publish index + journal. Unjournaled legacy edits get a bounded full rescan.
 */
export function createPlanDiscoveryJournal({ now = Date.now, maxTailBytes = 1024 * 1024, fullScanMs = 5000 } = {}) {
  let previous = null, lastFull = -Infinity;
  return root => {
    const indexFile = path.join(root, 'index.jsonl'), journalFile = path.join(root, '.changes.jsonl');
    let next;
    try { next = { root, index: stat(indexFile), journal: stat(journalFile) }; }
    catch { previous = null; return { full: true, changed: new Set() }; }
    const old = previous; previous = next;
    const reset = () => { lastFull = now(); return { full: true, changed: new Set() }; };
    if (!old || old.root !== root || now() - lastFull >= fullScanMs) return reset();
    const indexChanged = token(next.index) !== token(old.index);
    if (token(next.journal) === token(old.journal)) {
      return indexChanged ? reset() : { full: false, changed: new Set() };
    }
    if (!next.journal || !old.journal || identity(next.journal) !== identity(old.journal)) return reset();
    const length = Number(next.journal.size - old.journal.size);
    if (length <= 0 || length > maxTailBytes) return reset();
    let fd;
    try {
      fd = openSync(journalFile, 'r');
      const body = Buffer.allocUnsafe(length);
      if (readSync(fd, body, 0, length, Number(old.journal.size)) !== length || body.at(-1) !== 10) return reset();
      const changed = new Set();
      for (const line of body.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (typeof row?.planId !== 'string' || !row.planId) return reset();
        changed.add(row.planId);
      }
      if (indexChanged && !changed.size || token(stat(indexFile)) !== token(next.index)
        || token(stat(journalFile)) !== token(next.journal)) return reset();
      return { full: false, changed };
    } catch { return reset(); }
    finally { if (fd !== undefined) closeSync(fd); }
  };
}
