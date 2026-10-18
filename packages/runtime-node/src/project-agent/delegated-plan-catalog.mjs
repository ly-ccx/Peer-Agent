import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const version = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

/** Discovery metadata only. Current plans still pass through the store's overlay and guards. */
export function createDelegatedPlanCatalog({ directory, readPlan, maxEntries = 4096 }) {
  const candidates = new Map();
  return {
    read() {
      let names;
      try { names = readdirSync(directory()).filter(name => name.endsWith('.json')); }
      catch { candidates.clear(); return []; }
      const present = new Set(names), plans = [];
      for (const name of candidates.keys()) if (!present.has(name)) candidates.delete(name);
      for (const name of names) {
        try {
          const file = path.join(directory(), name), token = version(statSync(file, { bigint: true }));
          let cached = candidates.get(name);
          if (cached?.token !== token) {
            const value = JSON.parse(readFileSync(file, 'utf8'));
            // Do not publish discovery from a file changed during this read.
            if (version(statSync(file, { bigint: true })) !== token) throw new Error('plan_discovery_changed');
            cached = { token, delegated: Boolean(value?.delegationOrigin?.sessionId) };
          }
          candidates.delete(name); candidates.set(name, cached);
          if (candidates.size > maxEntries) candidates.delete(candidates.keys().next().value);
          if (!cached.delegated) continue;
          const plan = readPlan(name.slice(0, -5));
          if (plan?.delegationOrigin?.sessionId) plans.push(plan);
        } catch { candidates.delete(name); /* Match unavailable/corrupt legacy discovery. */ }
      }
      return plans;
    },
  };
}
