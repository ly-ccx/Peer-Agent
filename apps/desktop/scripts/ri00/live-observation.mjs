/** Serialized into the inspected process. Dependencies are explicit for fixture tests. */
export function installObservation(deps, options) {
  const { ipcMain, fs, json, phase, stores, timerHosts, timers, syncExports, now, wall, AsyncLocalStorage } = deps;
  const als = new AsyncLocalStorage();
  const contexts = new Set();
  const currentRow = () => als.getStore()?.row;
  const state = { startedAt: wall(), startedMono: now(), records: [], gaps: [], phases: {},
    dropped: 0, droppedTimerWrappers: 0, stopped: false, detailed: options.detailed !== false };
  const restores = [], adopted = new WeakSet(), own = new Set();
  const modules = new Map();
  const limit = options.limit || 20000;
  let sequence = 0, heartbeat, watchdog;
  let phaseCapture = true, switchPhase = () => {};
  const nativeInterval = timers.setInterval.bind(timers), nativeTimeout = timers.setTimeout.bind(timers);
  const nativeClearInterval = timers.clearInterval.bind(timers), nativeClearTimeout = timers.clearTimeout.bind(timers);
  function metric(row, name, duration, children = 0) {
    const value = row.metrics[name] ||= { calls: 0, inclusiveMs: 0, selfMs: 0, maxMs: 0 };
    value.calls++; value.inclusiveMs += duration; value.selfMs += Math.max(0, duration - children);
    value.maxMs = Math.max(value.maxMs, duration);
  }
  function measure(name, callback) {
    const row = currentRow();
    if (state.stopped || !state.detailed || !row || row.closed) return callback();
    const parent = row.stack.at(-1), frame = { started: now(), children: 0 };
    row.stack.push(frame);
    try { return callback(); }
    finally {
      const ms = now() - frame.started; row.stack.pop(); if (parent) parent.children += ms;
      metric(row, name, ms, frame.children);
    }
  }
  function retain(row) {
    if (row.retained) return;
    row.retained = true;
    // Ignore short timer metadata, but retain every IPC and every >1ms root.
    if (row.kind === 'timer' && row.synchronousMs < 1) return;
    if (state.records.length < limit) state.records.push(row); else state.dropped++;
  }
  function root(kind, name, fn, receiver, args, awaitResult = false, extra = {}) {
    if (state.stopped) return Reflect.apply(fn, receiver, args);
    const parent = currentRow();
    let row = { id: ++sequence, parent: parent && !parent.closed ? parent.id : null,
      kind, name, at: wall(), entered: now(), detailed: state.detailed, phaseCapture, metrics: {}, phases: {}, stack: [],
      ...(kind === 'ipc-invoke' ? { scope: deps.scopeOf?.(args[1]) || {} } : {}), ...extra };
    row.moduleCapture = Object.fromEntries([...modules].map(([name, group]) => [name, group.enabled]));
    // Clear this small cell explicitly: disable() alone need not erase inherited frames.
    const context = { row }; contexts.add(context);
    const release = () => { context.row = undefined; contexts.delete(context); };
    const settle = rejected => {
      const active = context.row;
      if (active && !state.stopped) { active.settled = now(); if (rejected) active.rejected = true; active.closed = true; retain(active); }
      release();
    };
    try { return als.run(context, () => {
      let value, failed = false;
      try { value = Reflect.apply(fn, receiver, args); return value; }
      catch (error) { failed = true; throw error; }
      finally {
        row.syncEnd = now(); row.synchronousMs = row.syncEnd - row.entered; row.threw = failed;
        if (awaitResult && !failed && value instanceof Promise) {
          // Return the original Promise. Observing settlement does not substitute its result or rejection.
          value.then(() => settle(false), () => settle(true));
        } else { row.settled = row.syncEnd; row.closed = true; retain(row); release(); }
      }
    }); } finally { row = undefined; }
  }
  function replace(object, key, wrapped) {
    const original = object[key]; object[key] = wrapped(original);
    const installed = object[key];
    let restored = false;
    const handle = {
      restore() { if (restored) return object[key] === original; if (object[key] !== installed) return false;
        object[key] = original; restored = true; return true; },
      install() { if (object[key] !== original) return false; object[key] = installed; restored = false; return true; },
    };
    restores.push(handle.restore); return handle;
  }
  function category(file) {
    if (typeof file !== 'string') return 'descriptor-or-other';
    if (file.includes('/diagnostics/') || file.includes('/logs/')) return 'diagnostic';
    if (file.includes('evidence-index')) return 'evidence';
    if (file.includes('/goal-plans/')) return 'plan';
    if (file.includes('/conversations/')) return 'conversation';
    if (file.includes('coordination') || file.includes('/runtime/')) return 'coordination';
    return 'other';
  }
  function readStack() {
    const previous = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 24;
      return String(new Error().stack).split('\n').slice(1).flatMap(line => {
        const match = line.trim().match(/^at (?:async )?([^\n()]+?) \((?:.*[/\\])?([^/\\():]+):(\d+):\d+\)$/);
        if (!match || !/\.(?:mjs|cjs|js|ts)$/.test(match[2])) return [];
        return [{ function: match[1].slice(0,120), file: match[2], line: Number(match[3]) }];
      }).slice(0,16);
    } catch { return []; }
    finally { Error.stackTraceLimit = previous; }
  }
  const map = ipcMain._invokeHandlers;
  if (!(map instanceof Map)) throw new Error('invoke_handler_map_missing');
  const channels = [...map.keys()];
  function stop() {
    if (!state.stopped) {
      state.stopped = true; nativeClearInterval(heartbeat); nativeClearTimeout(watchdog);
      state.restored = restores.reverse().map(fn => { try { return fn(); } catch { return false; } });
      for (const context of contexts) {
        if (context.row) { context.row.observationEndedBeforeSettlement = true; context.row.closed = true; retain(context.row); }
        context.row = undefined;
      }
      contexts.clear();
      restores.length = 0; als.disable(); syncExports(); state.finishedAt = wall(); state.finishedMono = now();
      state.addedInvokeChannels = [...map.keys()].filter(key => !channels.includes(key)).length;
    }
    return state;
  }
  try {
  for (const channel of channels) {
    const original = map.get(channel);
    const wrapped = function (...args) { return root('ipc-invoke', channel, original, this, args, true); };
    map.set(channel, wrapped);
    restores.push(() => { if (map.get(channel) !== wrapped) return false; map.set(channel, original); return true; });
  }
  const eventNames = new Set(ipcMain.eventNames?.() || []);
  if (typeof ipcMain.emit === 'function') replace(ipcMain, 'emit', original => function (channel, ...args) {
    return root('ipc-send', eventNames.has(channel) ? String(channel) : 'uncatalogued-event', original, this, [channel, ...args]);
  });
  const methods = ['read', 'readLifecycleFacts', 'readSnapshot', 'readSessionControl', 'readWork'];
  for (const store of new Set(stores)) for (const key of methods) {
    if (typeof store?.[key] === 'function') replace(store, key, original => function (...args) {
      return measure(`Coordination.${key}`, () => Reflect.apply(original, this, args));
    });
  }
  if (options.deepBuiltins !== false) {
  for (const key of ['statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'existsSync', 'appendFileSync', 'writeFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'fsyncSync']) {
    if (typeof fs[key] === 'function') replace(fs, key, original => function (...args) {
      return measure(`fs.${key}:${category(args[0])}`, () => Reflect.apply(original, this, args));
    });
  }
  for (const key of ['parse', 'stringify']) replace(json, key, original => function (...args) {
    return measure(`JSON.${key}`, () => Reflect.apply(original, this, args));
  });
  }
  if (phase) {
    let previous, active;
    const observer = (name, fields) => {
      const row = currentRow();
      if (!state.stopped && state.detailed && row && !row.closed && /^(plan\.(normalize|catalog|reportRevision)|watch\.[a-zA-Z]+)$/.test(name)) {
        const item = row.phases[name] ||= { calls: 0, ms: 0, hit: 0, miss: 0 };
        item.calls++; item.ms += Number(fields?.ms) || 0;
        if (fields?.hit === 1) item.hit++; else if (fields?.hit === 0) item.miss++;
      }
      return previous?.(name, fields);
    };
    previous = phase.setDiagnosticPhaseObserver(observer);
    active = observer;
    switchPhase = enabled => {
      const next = enabled ? observer : previous;
      const current = phase.setDiagnosticPhaseObserver(next);
      if (current !== active) { phase.setDiagnosticPhaseObserver(current); throw new Error('phase_observer_owner_changed'); }
      active = next; phaseCapture = enabled;
      (state.transitions ||= []).push({ at: wall(), mono: now(), phaseCapture: enabled });
    };
    restores.push(() => { const current = phase.setDiagnosticPhaseObserver(previous); if (current === active) return true; phase.setDiagnosticPhaseObserver(current); return false; });
  }
  function adoptTimer(handle) {
    if (!handle || own.has(handle) || adopted.has(handle) || handle._destroyed || typeof handle._onTimeout !== 'function') return;
    if (adoptedCount >= limit) { state.droppedTimerWrappers++; return; }
    adopted.add(handle); adoptedCount++;
    const original = handle._onTimeout, timerId = adoptedCount;
    const wrapped = function (...args) { return root('timer', original.name || 'anonymous-timer', original, this, args, false,
      { timerId, intervalMs: handle._repeat || 0, delayMs: handle._idleTimeout }); };
    handle._onTimeout = wrapped;
    restores.push(() => {
      if (handle._onTimeout === wrapped) { handle._onTimeout = original; return true; }
      return Boolean(handle._destroyed || handle._onTimeout == null);
    });
  }
  let adoptedCount = 0;
  for (const host of new Set(timerHosts)) for (const key of ['setTimeout', 'setInterval']) {
    replace(host, key, original => function (...args) { const handle = Reflect.apply(original, this, args); adoptTimer(handle); return handle; });
  }
  syncExports();
  let last = now();
  heartbeat = nativeInterval(() => {
    const at = now(); if (at - last > 50) {
      if (state.gaps.length < limit) state.gaps.push({ from: last, to: at, gapMs: at - last, at: wall() }); else state.dropped++;
    }
    last = at;
  }, 20); own.add(heartbeat); heartbeat.unref?.();
  watchdog = nativeTimeout(() => { stop(); options.onWatchdog?.(); }, options.durationMs + 30000);
  own.add(watchdog); watchdog.unref?.();
  return { stop, peek: () => state, adoptTimers(handles) { for (const handle of handles) adoptTimer(handle); return adoptedCount; },
    instrumentObject(object, module, methods, portOptions = {}) {
      if(modules.has(module))throw new Error('read_port_already_observed');
      const group={enabled:true,handles:[]};modules.set(module,group);
      for (const key of methods) {
        if (typeof object[key] !== 'function') throw new Error('read_port_method_missing');
        group.handles.push(replace(object, key, original => function (...args) {
          const observe = () => {
            const result = measure(`${module}.${key}`, () => Reflect.apply(original, this, args));
            const row = currentRow(), metric = row?.metrics[`${module}.${key}`];
            if (metric && Array.isArray(result)) metric.resultRows = (metric.resultRows || 0) + result.length;
            return result;
          };
          const parent = currentRow();
          if (!state.stopped && portOptions.rootWhenUnattributed && (!parent || parent.syncEnd !== undefined)) {
            return root('read-port', `${module}.${key}`, () => {
              currentRow().sourceStack = readStack(); return observe();
            }, this, []);
          }
          return observe();
        }));
      }
      return methods.length;
    },
    setModuleCapture(module, enabled) {
      const group=modules.get(module);if(!group)throw new Error('read_port_not_observed');
      if(group.enabled!==enabled){for(const handle of group.handles)if(!(enabled?handle.install():handle.restore()))throw new Error('read_port_owner_changed');group.enabled=enabled;}
      (state.moduleTransitions||=[]).push({module,enabled,at:wall(),mono:now()});
    },
    setDetailed(enabled) { state.detailed = enabled === true; }, setPhaseCapture(enabled) { switchPhase(enabled === true); },
    ownTimerPrototype: Object.getPrototypeOf(heartbeat) };
  } catch (error) { stop(); throw error; }
}
