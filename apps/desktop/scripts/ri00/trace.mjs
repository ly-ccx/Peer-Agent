import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';

/** A close probe never reuses a socket which the inspected server is shutting down. */
export function inspectorEndpoint(url,{signal}={}){
  return new Promise((resolve,reject)=>{
    const request=http.get(url,{agent:false,signal},response=>{
      // Headers prove the listener answered. Its body is not evidence of closure.
      response.on('error',()=>{});response.resume();resolve({status:response.statusCode});
    });
    request.on('error',cause=>reject(new Error('inspector_endpoint_failed',{cause})));
  });
}

/** Wait for an owned inspector's deferred close, without mistaking a timeout for refusal. */
export async function inspectClosure(port, { required = true, timeoutMs = 15000, fetchImpl = inspectorEndpoint,
  now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const started = now(), deadline = started + timeoutMs;
  let status = 'uncertain', checks = 0;
  do {
    checks++;
    try { await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) }); status = 'open'; }
    catch (error) { status = error.cause?.code === 'ECONNREFUSED' ? 'closed' : 'uncertain'; }
    if (status === 'closed' || !required || now() >= deadline) break;
    await wait(Math.min(250, deadline - now()));
  } while (now() <= deadline);
  return { closed: status === 'closed', status, checks, elapsedMs: now() - started };
}
import { performance } from 'node:perf_hooks';

export function distribution(values) {
  if (!values.length) return { n: 0, p50: null, p95: null, max: null };
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new TypeError('invalid measurement');
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: sorted[Math.floor(sorted.length * .5)],
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)], max: sorted.at(-1) };
}

export function inspectorValue(reply) {
  if (reply?.exceptionDetails || reply?.result?.subtype === 'error') throw new Error('inspector_evaluation_failed');
  return reply?.result?.value;
}

/** Four timestamps give an offset interval; uncertainty is retained, never rounded into zero queue time. */
export function synchronizeClocks(rows, { timestampUncertaintyMs = 0 } = {}) {
  if (!rows.length) throw new Error('clock_calibration_missing');
  const lower = Math.max(...rows.map(row => row.settledMain - row.end)) - timestampUncertaintyMs;
  const upper = Math.min(...rows.map(row => row.enteredMain - row.start)) + timestampUncertaintyMs;
  if (lower > upper) throw new Error('clock_calibration_inconsistent');
  return { offsetMs: (lower + upper) / 2, uncertaintyMs: (upper - lower) / 2, lower, upper, timestampUncertaintyMs };
}

export function requestPhases(row, calibration) {
  const sendQueueMs = row.enteredMain - row.start - calibration.offsetMs;
  const handlerMs = row.settledMain - row.enteredMain;
  const replyMs = row.end + calibration.offsetMs - row.settledMain;
  return { sendQueueMs, handlerMs, replyMs, uncertaintyMs: calibration.uncertaintyMs,
    roundTripMs: row.end - row.start };
}

/** Inclusive and self times are kept separately; nested totals must never be added. */
export function createTrace({ enabled = true, now = () => performance.now() } = {}) {
  const context = new AsyncLocalStorage();
  const completed = [];
  let next = 0;
  function sync(name, fn) {
    const scope = context.getStore();
    if (!enabled || !scope) return fn();
    const parent = scope.stack.at(-1);
    const frame = { name, started: now(), children: 0 };
    scope.stack.push(frame);
    try { return fn(); }
    finally {
      const elapsed = now() - frame.started;
      scope.stack.pop();
      if (parent) parent.children += elapsed;
      const key = [...scope.stack.map(item => item.name), name].join(' > ');
      const row = scope.metrics[key] ??= { calls: 0, inclusiveMs: 0, selfMs: 0, maxMs: 0 };
      row.calls += 1; row.inclusiveMs += elapsed; row.selfMs += Math.max(0, elapsed - frame.children);
      row.maxMs = Math.max(row.maxMs, elapsed);
      if (elapsed >= 50) scope.slow.push({ name, parent: parent?.name ?? null,
        startMs: frame.started - scope.started, durationMs: elapsed, selfMs: Math.max(0, elapsed - frame.children) });
    }
  }
  function wrap(object, key, name) {
    const original = object?.[key];
    if (typeof original !== 'function' || !enabled) return () => {};
    const wrapped = function (...args) { return sync(name, () => Reflect.apply(original, this, args)); };
    object[key] = wrapped;
    return () => { if (object[key] === wrapped) object[key] = original; };
  }
  async function request(name, fn) {
    const started = now();
    const scope = { requestId: ++next, name, started, at: new Date().toISOString(),
      stack: [{ name, started, children: 0 }], metrics: {}, slow: [], counts: {} };
    return context.run(scope, async () => {
      try { return await fn(); }
      finally {
        const durationMs = now() - started;
        const { stack, started: ignored, ...receipt } = scope;
        completed.push({ ...receipt, durationMs, unsegmentedOrAwaitMs: Math.max(0, durationMs - stack[0].children) });
      }
    });
  }
  return { sync, wrap, request,
    enabled: () => enabled,
    setEnabled(value) { if (typeof value !== 'boolean') throw new TypeError('invalid trace toggle'); enabled = value; },
    count(name, value = 1) { const scope = context.getStore(); if (enabled && scope) scope.counts[name] = (scope.counts[name] || 0) + value; },
    take() { return completed.splice(0); } };
}

export function summarizeRequests(requests) {
  const groups = {};
  for (const request of requests) {
    const rows = groups[request.name] ??= [];
    rows.push(request);
  }
  return Object.fromEntries(Object.entries(groups).map(([name, rows]) => [name, {
    durationMs: distribution(rows.map(row => row.durationMs)),
    counts: Object.fromEntries([...new Set(rows.flatMap(row => Object.keys(row.counts)))].map(key =>
      [key, distribution(rows.map(row => row.counts[key] || 0))])),
  }]));
}
