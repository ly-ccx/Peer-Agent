// Optional fixture-only observation of Electron's main thread. No product admission path.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Session } from 'node:inspector';

export function startMainThreadProbe(prefix) {
  if (!prefix) return;
  const write = fs.writeFileSync;
  const slowIo = [], beats = [];
  for (const name of ['readFileSync', 'writeFileSync', 'statSync', 'readdirSync', 'renameSync', 'openSync', 'closeSync']) {
    const original = fs[name];
    fs[name] = function (...args) {
      const start = performance.now();
      try { return original.apply(this, args); }
      finally {
        const elapsed = performance.now() - start;
        if (elapsed > 20) slowIo.push({ name, elapsed, stack: new Error().stack });
      }
    };
  }
  syncBuiltinESMExports();
  const session = new Session(); session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  let busy = false, sequence = 0, last = performance.now(), cpu = process.cpuUsage();
  void post('Profiler.enable').then(() => post('Profiler.setSamplingInterval', { interval: 10000 })).then(() => post('Profiler.start'));
  const timer = setInterval(async () => {
    const at = performance.now(), elapsed = at - last, used = process.cpuUsage(cpu); last = at; cpu = process.cpuUsage();
    beats.push({ at: new Date().toISOString(), elapsed, cpuMs: (used.user + used.system) / 1000 });
    write(prefix + '-loop.json', JSON.stringify({ beats, slowIo }, null, 2));
    if (busy) return;
    busy = true;
    try {
      const { profile } = await post('Profiler.stop');
      write(prefix + '-' + sequence++ + '.cpuprofile', JSON.stringify(profile));
      await post('Profiler.start');
    } catch (error) { write(prefix + '-error.txt', String(error)); }
    finally { busy = false; }
  }, 10000);
  timer.unref();
}
