import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { noteDiagnosticPhase } from '../diagnostic-phase.mjs';
import { createPlanDiscoveryJournal } from './plan-discovery-journal.mjs';

const version = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

/** Discovery metadata only. Current plans still pass through the store's overlay and guards. */
export function createDelegatedPlanCatalog({ directory, readPlan, maxEntries = 4096, incremental = false, now = Date.now }) {
  const candidates = new Map();
  const delegatedEntries = new Map();
  const observe = incremental ? createPlanDiscoveryJournal({ now }) : null;
  let previousRoot;
  let lastDirToken = '';
  let lastJsonCount = 0;

  function hydrateFiltered(entries, filterSessionId, filterWorkspaceId, filterWorkspaceIds) {
    const plans = [];
    const deferred = [];
    for (const [planId, meta] of entries) {
      try {
        if (filterSessionId) {
          if (meta.sessionId === filterSessionId) {
            const plan = readPlan(planId);
            if (plan?.delegationOrigin?.sessionId === filterSessionId) plans.push(plan);
          } else {
            deferred.push(planId);
          }
          continue;
        }
        if (filterWorkspaceId && meta.workspaceId !== filterWorkspaceId) continue;
        if (filterWorkspaceIds && !filterWorkspaceIds.has(meta.workspaceId)) continue;
        const plan = readPlan(planId);
        if (!plan?.delegationOrigin?.sessionId) continue;
        if (filterWorkspaceId && plan.delegationOrigin.workspaceId !== filterWorkspaceId) continue;
        if (filterWorkspaceIds && !filterWorkspaceIds.has(plan.delegationOrigin.workspaceId)) continue;
        plans.push(plan);
      } catch { /* Match unavailable/corrupt legacy discovery. */ }
    }
    if (filterSessionId && plans.length === 0 && deferred.length > 0) {
      for (const planId of deferred) {
        try {
          const plan = readPlan(planId);
          if (plan?.delegationOrigin?.sessionId === filterSessionId) {
            plans.push(plan);
            break;
          }
        } catch { /* Match unavailable/corrupt legacy discovery. */ }
      }
    }
    return plans;
  }

  return {
    read(filter = null) {
      let root;
      try { root = directory(); }
      catch { candidates.clear(); delegatedEntries.clear(); lastDirToken = ''; lastJsonCount = 0; return []; }
      if (root !== previousRoot) {
        candidates.clear();
        delegatedEntries.clear();
        previousRoot = root;
        lastDirToken = '';
        lastJsonCount = 0;
      }
      const invalidation = observe?.(root);
      const filterSessionId = typeof filter?.sessionId === 'string' && filter.sessionId ? filter.sessionId : null;
      const filterWorkspaceId = typeof filter?.workspaceId === 'string' && filter.workspaceId ? filter.workspaceId : null;
      const filterWorkspaceIds = filter?.workspaceIds instanceof Set ? filter.workspaceIds
        : Array.isArray(filter?.workspaceIds) ? new Set(filter.workspaceIds) : null;

      let dirToken = '';
      try { dirToken = version(statSync(root, { bigint: true })); }
      catch { candidates.clear(); delegatedEntries.clear(); lastDirToken = ''; lastJsonCount = 0; return []; }

      // When directory membership, journal, and index are all unchanged and nothing was evicted,
      // skip readdirSync + iterating all historical non-delegated files and hydrate only known delegated entries.
      if (
        invalidation
        && !invalidation.full
        && invalidation.changed.size === 0
        && dirToken === lastDirToken
        && lastJsonCount > 0
        && candidates.size === lastJsonCount
      ) {
        return hydrateFiltered(delegatedEntries, filterSessionId, filterWorkspaceId, filterWorkspaceIds);
      }

      let names;
      try { names = readdirSync(root).filter(name => name.endsWith('.json')); }
      catch { candidates.clear(); delegatedEntries.clear(); lastDirToken = ''; lastJsonCount = 0; return []; }
      const present = new Set(names);
      for (const name of candidates.keys()) {
        if (!present.has(name)) {
          candidates.delete(name);
          delegatedEntries.delete(name.slice(0, -5));
        }
      }
      const matched = [];
      for (const name of names) {
        const planId = name.slice(0, -5);
        try {
          let cached = candidates.get(name);
          const file = path.join(root, name);
          const inspect = !invalidation || invalidation.full || invalidation.changed.has(planId) || !cached;
          const token = inspect ? version(statSync(file, { bigint: true })) : cached.token;
          if (!cached || cached.token !== token) {
            const started = performance.now();
            const raw = readFileSync(file, 'utf8');
            const value = raw.includes('"delegationOrigin"') ? JSON.parse(raw) : null;
            noteDiagnosticPhase('plan.catalog', { hit: 0, ms: performance.now() - started });
            // Do not publish discovery from a file changed during this read.
            if (version(statSync(file, { bigint: true })) !== token) throw new Error('plan_discovery_changed');
            const origin = value?.delegationOrigin;
            const sessionId = typeof origin?.sessionId === 'string' && origin.sessionId ? origin.sessionId : '';
            const workspaceId = typeof origin?.workspaceId === 'string' && origin.workspaceId ? origin.workspaceId : '';
            cached = { token, delegated: Boolean(sessionId), sessionId, workspaceId };
          }
          if (candidates.size >= maxEntries || !candidates.has(name)) {
            candidates.delete(name);
            candidates.set(name, cached);
          } else {
            candidates.set(name, cached);
          }
          if (candidates.size > maxEntries) {
            const evicted = candidates.keys().next().value;
            candidates.delete(evicted);
            delegatedEntries.delete(evicted.slice(0, -5));
          }
          if (cached.delegated) {
            const meta = { sessionId: cached.sessionId, workspaceId: cached.workspaceId };
            delegatedEntries.set(planId, meta);
            matched.push([planId, meta]);
          } else {
            delegatedEntries.delete(planId);
          }
        } catch {
          candidates.delete(name);
          delegatedEntries.delete(planId);
          /* Match unavailable/corrupt legacy discovery. */
        }
      }
      lastDirToken = dirToken;
      lastJsonCount = names.length;
      return hydrateFiltered(matched, filterSessionId, filterWorkspaceId, filterWorkspaceIds);
    },
  };
}
