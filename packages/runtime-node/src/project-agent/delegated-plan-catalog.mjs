import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createPlanDiscoveryJournal } from './plan-discovery-journal.mjs';

const version = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

/** Discovery metadata only. Current plans still pass through the store's overlay and guards. */
export function createDelegatedPlanCatalog({ directory, readPlan, maxEntries = 4096, incremental = false, now = Date.now }) {
  const candidates = new Map();
  const observe = incremental ? createPlanDiscoveryJournal({ now }) : null;
  let previousRoot;
  return {
    read() {
      let names, root;
      try { root = directory(); names = readdirSync(root).filter(name => name.endsWith('.json')); }
      catch { candidates.clear(); return []; }
      if (root !== previousRoot) { candidates.clear(); previousRoot = root; }
      const invalidation = observe?.(root);
      const present = new Set(names), plans = [];
      for (const name of candidates.keys()) if (!present.has(name)) candidates.delete(name);
      for (const name of names) {
        try {
          let cached = candidates.get(name);
          const file = path.join(root, name);
          const inspect = !invalidation || invalidation.full || invalidation.changed.has(name.slice(0, -5)) || !cached;
          const token = inspect ? version(statSync(file, { bigint: true })) : cached.token;
          if (!cached || cached.token !== token) {
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
