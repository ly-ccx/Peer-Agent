import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import { inspectCoordinationFork, recoverCoordinationForkBackup, readRecoveredCoordination } from './coordination-fork-recovery.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { historyTerminal, historyWorkHeld, historyCheckpointBindings, planHistoryResumption, recoveryHash } from './history-resumption.mjs';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
function json(file) {
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) fail('coordination_repair_path_invalid');
  return JSON.parse(readFileSync(file, 'utf8'));
}
function durable(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  const parent = openSync(path.dirname(file), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}

/** Local host maintenance. No model execution, permission grants, queue consumption or source-path input. */
export function createCoordinationRecoveryService({ rootDir, holdsLease, leaseEpoch, readLease = () => null,
  quiesce, restart, cancelSessions, isReady = () => false, sessionSafe = () => false, sessionInventory = () => [], titleForWork = () => '', onChanged = () => {} } = {}) {
  const flights = new Map();
  const views = new Map();
  const directory = id => {
    if (!validId(id)) fail('invalid_workspace');
    const root = realpathSync(rootDir), dir = path.join(root, id);
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir) fail('coordination_repair_path_invalid');
    return dir;
  };
  const assertOwner = (id, epoch) => {
    if (!epoch || holdsLease(id) !== true || leaseEpoch(id) !== epoch) fail('coordination_lease_lost');
  };
  function status(id, value) {
    const dir = directory(id), file = path.join(dir, 'recovery-action.json');
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) fail('coordination_repair_path_invalid');
    durable(file, { schemaVersion: 1, ...value, at: new Date().toISOString() });
    const view = views.get(id);
    if (view) views.set(id, { ...view, ...value });
    onChanged(id);
  }
  function checkpointReader(dir, state) {
    return (workId, ref) => {
      if (!/^[a-f0-9]{64}\.json$/.test(ref || '')) fail('invalid_checkpoint');
      const folder = path.join(dir, 'checkpoints');
      if (lstatSync(folder).isSymbolicLink()) fail('coordination_repair_path_invalid');
      const file = path.join(folder, ref);
      if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) fail('coordination_repair_path_invalid');
      const bytes = readFileSync(file);
      const owners = historyCheckpointBindings(state.works[workId]).filter(row => row.ref === ref).map(row => row.owner);
      if (!owners.some(owner => createHash('sha256').update(owner + '\n').update(bytes).digest('hex') + '.json' === ref)) fail('coordination_checkpoint_changed');
      return JSON.parse(bytes);
    };
  }
  function savedInspection(dir) {
    const intent = json(path.join(dir, 'coordination-recovery.json'));
    if (intent.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(intent.sourceFingerprint || '')
      || intent.archive !== `.coordination-recovery/${intent.sourceFingerprint}`) fail('coordination_repair_plan_changed');
    for (const folder of ['.coordination-recovery', intent.archive]) if (lstatSync(path.join(dir, folder)).isSymbolicLink()) fail('coordination_repair_path_invalid');
    const inspection = json(path.join(dir, intent.archive, 'inspection.json'));
    if (inspection.sourceFingerprint !== intent.sourceFingerprint || recoveryHash(inspection.sources) !== intent.sourceFingerprint) fail('coordination_repair_plan_changed');
    return { intent, inspection };
  }
  async function inspectOwned(id, epoch) {
    assertOwner(id, epoch);
    const dir = directory(id), hasIntent = existsSync(path.join(dir, 'coordination-recovery.json'));
    const saved = hasIntent ? savedInspection(dir) : null;
    const restored = saved?.intent.status === 'complete';
    const inspection = saved?.inspection ?? inspectCoordinationFork(dir);
    const published = restored ? readRecoveredCoordination(dir, saved.intent.generation, { includeProof: true }) : null;
    const state = published?.state ?? inspection.state;
    assertOwner(id, epoch);
    const admitted = state.lastRecovery?.executionBlocked === false;
    const sessions = sessionInventory(id).filter(row => row && typeof row.sessionId === 'string' && !row.terminal);
    const decisions = planHistoryResumption(state, inspection, { readCheckpoint: checkpointReader(dir, state), sessionSafe: sessionId => sessionSafe(id, sessionId) });
    const title = work => {
      let text = titleForWork(id, work) || work.title;
      if (!text) try { text = checkpointReader(dir, state)(work.workId, work.checkpointRef)?.job?.userInputs?.[0]?.text; } catch { /* Unverified history uses a neutral label. */ }
      return String(text || 'Earlier task').replace(/\s+/g, ' ').slice(0, 160);
    };
    const manifest = path.join(dir, 'coordination-v2/manifest.json'), head = path.join(dir, 'coordination-v2/head.json');
    const token = recoveryHash({ source: inspection.sourceFingerprint, revision: state.revision,
      decisions, publishedSource: published?.sourceFingerprint, sessions: sessions.map(row => row.sessionId).sort(), manifest: existsSync(manifest) ? json(manifest) : null, head: existsSync(head) ? json(head) : null });
    const view = { phase: admitted ? 'ready' : 'inspection', planToken: token, restored, canContinue: admitted, runtimeReady: isReady(id) === true,
      completedCount: Object.values(state.works).filter(historyTerminal).length,
      works: decisions.map(row => ({ workId: row.workId, disposition: row.disposition, reason: row.reason,
        title: title(state.works[row.workId]) })),
      sessions: sessions.filter(row => (!admitted || state.lastRecovery.quarantinedSessionIds?.includes(row.sessionId))
        && !state.lastRecovery?.retainedSessionIds?.includes(row.sessionId))
        .map(row => ({ sessionId: row.sessionId, title: String(row.title || 'Earlier task').slice(0, 160) })), backupAvailable: hasIntent,
      ...(saved ? { backupLocation: path.join(dir, saved.intent.archive) } : {}) };
    views.set(id, view);
    return { dir, inspection, state, token, decisions, sessions, view };
  }
  function backupInputs(dir, fingerprint, inspection) {
    // These live append-only inputs are preserved, never restored over newer input.
    const root = path.join(dir, '.coordination-recovery');
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) fail('coordination_repair_path_invalid');
    const archive = path.join(root, fingerprint);
    if (existsSync(archive) && lstatSync(archive).isSymbolicLink()) fail('coordination_repair_path_invalid');
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    const target = path.join(archive, `received-inputs-${randomUUID()}.json`), files = {};
    const names = ['input-queue.jsonl', 'input-cursor.json', 'inbox.jsonl', 'inbox-cursor.json', 'scheduler.json'];
    const oldWorks = [...Object.values(inspection.state.works), ...inspection.conflicts.filter(row => row.bucket === 'works')
      .flatMap(row => [row.baseline, row.current, row.legacy]).filter(Boolean)];
    for (const work of oldWorks) for (const { ref } of historyCheckpointBindings(work)) {
      if (/^[a-f0-9]{64}\.json$/.test(ref)) names.push(`checkpoints/${ref}`);
    }
    for (const name of new Set(names)) {
      if (name.startsWith('checkpoints/') && existsSync(path.join(dir, 'checkpoints')) && lstatSync(path.join(dir, 'checkpoints')).isSymbolicLink()) fail('coordination_repair_path_invalid');
      const file = path.join(dir, name);
      if (!existsSync(file)) continue;
      if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) fail('coordination_repair_path_invalid');
      const before = lstatSync(file, { bigint: true }), body = readFileSync(file), after = lstatSync(file, { bigint: true });
      if (['ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) fail('coordination_read_changed');
      files[name] = { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), base64: body.toString('base64') };
    }
    durable(target, { schemaVersion: 1, sourceFingerprint: fingerprint, files });
  }
  async function mutate(request, epoch) {
    const id = request.workspaceId;
    // Pause first, await all existing execution, and keep the actual lease.
    assertOwner(id, epoch); status(id, { phase: 'stopping' });
    let timer;
    try { await Promise.race([quiesce(id), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('coordination_recovery_stop_pending'), { code: 'coordination_recovery_stop_pending' })), 120000);
    })]); } finally { clearTimeout(timer); }
    assertOwner(id, epoch);
    let store;
    try {
      const plan = await inspectOwned(id, epoch);
      if (request.planToken !== plan.token) fail('coordination_resume_plan_changed');
      if (request.action === 'restore') {
        if (!plan.view.canContinue || plan.decisions.length) {
          status(id, { phase: 'backing_up' }); backupInputs(plan.dir, plan.inspection.sourceFingerprint, plan.inspection);
          status(id, { phase: 'restoring' });
          recoverCoordinationForkBackup({ directory: plan.dir, sourceFingerprint: plan.inspection.sourceFingerprint,
            reviewedPrefixSha256: plan.inspection.baselinePrefix.sha256, assertMaintenanceOwner: () => assertOwner(id, epoch) });
          assertOwner(id, epoch);
          // Version 3 readers must reject the new scoped-admission events before writing.
          const manifestFile = path.join(plan.dir, 'coordination-v2/manifest.json'), manifest = json(manifestFile);
          durable(manifestFile, { ...manifest, minimumReaderVersion: Math.max(4, manifest.minimumReaderVersion), minimumWriterVersion: Math.max(4, manifest.minimumWriterVersion) });
          status(id, { phase: 'reconciling' });
          store = createWorkCoordinationStore({ rootDir, workspaceId: id, formatVersion: 2,
            holdsLease: () => holdsLease(id), leaseEpoch: () => leaseEpoch(id) });
          await store.prepare(); assertOwner(id, epoch);
          const state = store.read();
          if (state.lastRecovery?.executionBlocked !== false || plan.decisions.length) {
            const decisions = planHistoryResumption(state, plan.inspection, { readCheckpoint: checkpointReader(plan.dir, state),
              sessionSafe: sessionId => sessionSafe(id, sessionId) });
            const originals = [...Object.values(plan.inspection.state.works), ...plan.inspection.conflicts.filter(row => row.bucket === 'works')
              .flatMap(row => [row.baseline, row.current, row.legacy]).filter(Boolean)];
            store.append({ kind: 'history_resume_admitted', sourceFingerprint: plan.inspection.sourceFingerprint,
              expectedRevision: state.revision, decisions, quarantinedSessionIds: plan.view.sessions.map(row => row.sessionId),
              quarantinedInputIds: [...new Set(originals.flatMap(work => work.anchorInputIds || []))],
              quarantinedEventIds: [...new Set(originals.flatMap(work => [...(work.pendingEventIds || []), ...(work.consumedEventIds || [])]))] });
          }
        }
      } else {
        const work = plan.state.works[request.workId];
        const heldSession = plan.view.sessions.find(row => row.sessionId === request.sessionId);
        if (!plan.view.canContinue || (request.sessionId ? !heldSession : !historyWorkHeld(work))) fail('coordination_resume_plan_changed');
        const sessions = request.sessionId ? [request.sessionId] : [...new Set(work.sessionIds || [])];
        if (sessions.length && typeof cancelSessions !== 'function') fail('coordination_recovery_stop_unavailable');
        if (sessions.length) await cancelSessions(id, sessions);
        assertOwner(id, epoch);
        store = createWorkCoordinationStore({ rootDir, workspaceId: id, formatVersion: 2,
          holdsLease: () => holdsLease(id), leaseEpoch: () => leaseEpoch(id) });
        await store.prepare(); assertOwner(id, epoch);
        const state = store.read();
        if (request.sessionId) store.append({ kind: 'history_session_retained', sessionId: request.sessionId,
          sourceFingerprint: plan.inspection.sourceFingerprint, expectedRevision: state.revision });
        else {
          const fresh = state.works[work.workId];
          if (recoveryHash(fresh) !== recoveryHash(work)) fail('coordination_resume_plan_changed');
          store.append({ kind: 'history_work_retained', workId: work.workId, workHash: recoveryHash(fresh),
            sourceFingerprint: plan.inspection.sourceFingerprint, expectedRevision: state.revision });
        }
      }
      store?.close(); store = null;
      status(id, { phase: 'ready' });
      // Reply admission opens only after the durable partition has been published.
      await restart(id); assertOwner(id, epoch);
      const result = await inspectOwned(id, epoch);
      return { ok: true, view: result.view };
    } finally { store?.close(); }
  }
  return {
    available(id) { try { return existsSync(path.join(directory(id), 'coordination-recovery.json')); } catch { return false; } },
    execute(request = {}) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) return Promise.resolve({ ok: false, code: 'INVALID_INPUT' });
      const id = request.workspaceId;
      if (!validId(id) || !['inspect', 'restore', 'retain'].includes(request.action)
        || request.action !== 'inspect' && !/^[a-f0-9]{64}$/.test(request.planToken || '')
        || request.action === 'retain' && (Boolean(request.workId) === Boolean(request.sessionId)
          || typeof (request.workId || request.sessionId) !== 'string' || (request.workId || request.sessionId).length > 200)) return Promise.resolve({ ok: false, code: 'INVALID_INPUT' });
      const key = JSON.stringify([request.action, request.planToken, request.workId, request.sessionId]);
      if (flights.has(id)) {
        if (request.action === 'inspect' && views.has(id)) return Promise.resolve({ ok: true, view: views.get(id) });
        return flights.get(id).key === key ? flights.get(id).promise : Promise.resolve({ ok: false, code: 'RECOVERY_BUSY' });
      }
      const run = (async () => {
        if (holdsLease(id) !== true) {
          const lease = readLease(id);
          return { ok: true, view: { phase: 'occupied', restored: false, canContinue: false, runtimeReady: false, completedCount: 0, works: [], sessions: [], backupAvailable: false,
            ...(lease ? { holder: { surface: lease.surface, version: lease.appVersion || '' } } : {}) } };
        }
        const epoch = leaseEpoch(id);
        try {
          if (request.action === 'inspect') return { ok: true, view: (await inspectOwned(id, epoch)).view };
          return await mutate(request, epoch);
        } catch (error) {
          const code = /^[A-Za-z0-9_:-]{1,120}$/.test(error?.code || error?.message || '') ? error.code || error.message : 'RECOVERY_FAILED';
          if (request.action !== 'inspect' && holdsLease(id)) { try { status(id, { phase: 'failed', code }); } catch { /* Keep the original failure. */ } }
          return { ok: false, code };
        }
      })().finally(() => flights.delete(id));
      flights.set(id, { key, promise: run }); return run;
    },
  };
}
