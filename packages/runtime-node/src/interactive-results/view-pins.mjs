import { interactiveToken, normalizeInteractiveReference, normalizeInteractiveViewHandle } from '@peer-agent/protocol';
import { decode, encode, problem } from './storage.mjs';

const CATEGORY = 'interactive-active-view';
const LIMIT = 256;

export function interactiveProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function readPins(context, owner) {
  const rows = context.db.prepare('SELECT id,body FROM presentation WHERE category=? AND owner=? ORDER BY id LIMIT ?')
    .all(CATEGORY, encode(owner), LIMIT + 1);
  if (rows.length > LIMIT) throw problem('interactive_view_limit');
  return rows.map(({ id, body }) => {
    const pin = decode(body), reference = normalizeInteractiveReference(pin?.reference);
    const handle = normalizeInteractiveViewHandle(pin?.handle);
    if (!pin || Object.keys(pin).length !== 5 || pin.schemaVersion !== 1 || !reference || encode(reference.owner) !== encode(owner)
      || !handle || handle.viewId !== id || !interactiveToken(pin.hostEpoch) || !Number.isSafeInteger(pin.pid) || pin.pid <= 0)
      throw problem('interactive_storage_corrupt');
    return { ...pin, reference, handle };
  });
}

export function readLiveInteractiveViewPins(context, owner) {
  return readPins(context, owner).filter(pin => interactiveProcessAlive(pin.pid));
}

export function registerInteractiveViewPin(resultStore, reference, handle, assertCurrent) {
  const { storage } = resultStore, { owner } = reference;
  const body = encode({ schemaVersion: 1, reference, handle, hostEpoch: storage.hostEpoch, pid: process.pid });
  const args = [CATEGORY, handle.viewId, encode(owner)];
  const registered = storage.transaction(owner.workspaceId, context => {
    assertCurrent();
    resultStore.getVersionMetadata(reference);
    const pins = readPins(context, owner);
    let alive = 0;
    for (const pin of pins) {
      if (interactiveProcessAlive(pin.pid)) alive++;
      else context.db.prepare('DELETE FROM presentation WHERE category=? AND id=? AND owner=?').run(CATEGORY, pin.handle.viewId, args[2]);
    }
    if (alive >= LIMIT) throw problem('interactive_view_limit');
    if (context.db.prepare('SELECT 1 FROM presentation WHERE category=? AND id=? AND owner=?').get(...args))
      throw problem('interactive_view_unavailable');
    context.db.prepare('INSERT INTO presentation VALUES(?,?,?,?)').run(...args, body);
    assertCurrent();
    return context;
  });
  return {
    assertPresent(context) {
      if (registered !== context) throw problem('interactive_storage_replaced');
      context.assertFile();
      if (context.db.prepare('SELECT body FROM presentation WHERE category=? AND id=? AND owner=?').get(...args)?.body !== body)
        throw problem('interactive_view_stale');
    },
    release: () => storage.transaction(owner.workspaceId, context => {
      context.db.prepare('DELETE FROM presentation WHERE category=? AND id=? AND owner=? AND body=?').run(...args, body);
    }),
  };
}
