/** Serialized into an owned/inspected host. Observes existing calls; never invokes an entry itself. */
export function createE3EntryAdapter(entries, readers, { epoch, maxRecords = 256, maxKinds = 8, maxRuns = 64, onFatal } = {}) {
  if (typeof epoch!=='string' || !epoch || epoch.length>128 || ![maxRecords,maxKinds,maxRuns].every(Number.isInteger) || maxRecords < 1 || maxRecords > 256 || maxKinds < 1 || maxKinds > 8 || maxRuns < 1 || maxRuns > 64) throw Error('e3_entry_bounds_required');
  if (!Array.isArray(entries) || !entries.length || entries.length > maxKinds || !Array.isArray(readers) || readers.length>8) throw Error('e3_entry_bindings_required');
  const { AsyncLocalStorage } = process.getBuiltinModule('async_hooks');
  const { performance } = process.getBuiltinModule('perf_hooks');
  const { isPromise, isProxy } = process.getBuiltinModule('util').types;
  const crypto = process.getBuiltinModule('crypto'), als = new AsyncLocalStorage();
  const records = [], installed = [], stacks = new Map(), acknowledged = new Map();
  let stopped = false, reason, restored, pending, sequence = 0, metadataErrors = 0;
  const shape = args => {
    const p = args[0], proxy = p && (typeof p === 'object' || typeof p === 'function') && isProxy(p);
    const object = !proxy && p && typeof p === 'object' && !Array.isArray(p);
    const value = key => object ? Object.getOwnPropertyDescriptor(p, key)?.value : undefined;
    return { firstType: proxy ? 'proxy' : Array.isArray(p) ? 'array' : typeof p, workspace: typeof value('workspaceId') === 'string',
      parent: typeof value('parentConversationId') === 'string', session: typeof value('sessionId') === 'string',
      query: typeof value('query') === 'string' && value('query').length>0, needsYouOnly: value('needsYouOnly') === true };
  };
  function fatal(why) {
    if (stopped) return;
    metadataErrors++;
    try { if (onFatal) onFatal(why); else api.stop(why); } catch { api.stop(why); }
  }
  function firstStack(kind) {
    if (stacks.has(kind)) return;
    const previous = Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit');
    try { Object.defineProperty(Error, 'stackTraceLimit', { configurable: true, writable: true, value: 48 });
      stacks.set(kind, String(new Error('ri00-e3-entry').stack).slice(0, 16384));
    } finally { if (previous) Object.defineProperty(Error, 'stackTraceLimit', previous); else delete Error.stackTraceLimit; }
  }
  function finish(record, completion) {
    record.completion = completion; record.end = performance.now(); if(stopped)record.completedAfterStop=true; record.revision++;
  }
  function port(name) {
    if (stopped) return;
    const record = als.getStore(); if (!record) return;
    if (name === 'plan') record.planCalls++;
    const last = record.portSequence.at(-1);
    if (last?.kind === name) last.count++;
    else if (record.portSequence.length < maxRuns) record.portSequence.push({ kind: name, count: 1 });
    else { record.truncated = true; fatal('entry-port-cap'); }
    record.revision++;
  }
  function wrap({ object, key, kind, port: reader, layered = false }) {
    if (!object || typeof key !== 'string' || typeof object[key] !== 'function' || (!kind && !reader)
      || !/^[a-zA-Z0-9:._-]{1,80}$/.test(kind || reader)) throw Error('e3_entry_binding_invalid');
    if (installed.some(item => item.object === object && item.key === key)) throw Error('e3_entry_binding_duplicate');
    const original = object[key];
    const replacement = reader ? function (...args) {
      try { port(reader); } catch { fatal('entry-port-metadata'); }
      return Reflect.apply(original, this, args);
    } : function (...args) {
      if (stopped) return Reflect.apply(original, this, args);
      if (sequence >= maxRecords) { fatal('entry-record-cap'); return Reflect.apply(original, this, args); }
      let record;
      try {
        firstStack(kind);
        record = { seq: ++sequence, parentSeq: als.getStore()?.seq ?? null, kind, epoch,
          shapeDigest: crypto.createHash('sha256').update(JSON.stringify(shape(args))).digest('hex'),
          start: performance.now(), end: null, completion: 'entered', revision: 1, planCalls: 0, portSequence: [] };
        records.push(record);
      } catch { fatal('entry-start-metadata'); return Reflect.apply(original, this, args); }
      return als.run(record, () => {
        let value;
        try { value = Reflect.apply(original, this, args); }
        catch (error) { try { finish(record, 'threw'); } catch { fatal('entry-end-metadata'); } throw error; }
        try {
          if (isPromise(value)) {
            record.completion = 'promise-returned'; record.revision++;
            // Observe settlement without replacing the original Promise or promoting a thenable to a Promise.
            const settle = completion => { try { finish(record, completion); } catch { fatal('entry-end-metadata'); } };
            Promise.prototype.then.call(value, () => settle('fulfilled'), () => settle('rejected'));
          } else finish(record, 'returned');
        } catch { fatal('entry-settlement-metadata'); }
        return value;
      });
    };
    object[key] = replacement; installed.push({ object, key, original, replacement, layered, name: kind || reader });
  }
  const api = {
    context() { const r = stopped ? null : als.getStore(); return r ? { seq: r.seq, parentSeq: r.parentSeq, kind: r.kind, epoch: r.epoch, shapeDigest: r.shapeDigest } : null; },
    take() {
      if (pending) return pending;
      const rows = records.filter(r => r.revision > (acknowledged.get(r.seq) || 0));
      pending = { entries: rows.map(r => ({ ...r, portSequence: r.portSequence.map(p => ({ ...p })) })),
        stacks: Object.fromEntries(stacks), state: api.state() };
      if (Buffer.byteLength(JSON.stringify(pending)) > 16777216) { fatal('entry-unacknowledged-byte-cap'); throw Error('e3_entry_batch_too_large'); }
      return pending;
    },
    // The controller must fsync this exact immutable revision batch before calling ack.
    ack() { if (!pending) throw Error('e3_entry_ack_without_batch'); for (const r of pending.entries) acknowledged.set(r.seq, r.revision); pending = null; return true; },
    state() { return { stopped, reason, restored, records: sequence, metadataErrors,
      inFlight: records.filter(r => r.end === null).length, kinds: stacks.size }; },
    verifyOwners({ skipLayered = false } = {}) { return installed.filter(i => !skipLayered || !i.layered).every(i => i.object[i.key] === i.replacement); },
    stop(why = 'controller') {
      if (!stopped) { stopped = true; reason = why; restored = true;
        for (const i of [...installed].reverse()) {
          if (i.object[i.key] === i.replacement) i.object[i.key] = i.original;
          else if (i.object[i.key] !== i.original) restored = false;
        }
        als.disable();
      }
      return api.state();
    },
  };
  try { for (const binding of entries) wrap(binding); for (const binding of readers) wrap(binding); }
  catch (error) { api.stop('install-failed'); throw error; }
  return api;
}
