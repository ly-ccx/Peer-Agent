/** GC timestamps are aligned with main monotonic time; no collection is requested. */
export function observeGc({ PerformanceObserver, performance, now, wall, timers }, durationMs) {
  if (!PerformanceObserver.supportedEntryTypes.includes('gc')) throw new Error('gc_observation_unavailable');
  const before = now(), performanceAt = performance.now(), after = now();
  const state = { startedAt: wall(), offsetMs: (before + after) / 2 - performanceAt,
    uncertaintyMs: (after - before) / 2, entries: [], dropped: 0, stopped: false };
  function collect(entries) {
    for (const entry of entries) {
      if (state.entries.length >= 10000) { state.dropped++; continue; }
      state.entries.push({ startMono: entry.startTime + state.offsetMs, durationMs: entry.duration,
        kind: entry.detail?.kind, flags: entry.detail?.flags });
    }
  }
  const observer = new PerformanceObserver(list => collect(list.getEntries()));
  observer.observe({ entryTypes: ['gc'] });
  let watchdog;
  function stop() {
    if (!state.stopped) {
      collect(observer.takeRecords()); observer.disconnect(); timers.clearTimeout(watchdog);
      state.stopped = true; state.finishedAt = wall();
    }
    return state;
  }
  watchdog = timers.setTimeout(stop, durationMs); watchdog.unref?.();
  return { stop, peek: () => state };
}
