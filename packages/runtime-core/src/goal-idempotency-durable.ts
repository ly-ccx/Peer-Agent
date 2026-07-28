/**
 * Node-only durable Goal idempotency ledger (fs-backed).
 * Keep this out of the browser/renderer import graph.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  createGoalIdempotencyLedger,
  type GoalIdempotencyLedgerEntry,
} from './goal-idempotency.ts';

function asString(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.trim();
}

function createLedgerEntry(input: {
  readonly status: string;
  readonly evidenceRefs?: readonly string[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly planId?: string;
  readonly runId?: string;
}): GoalIdempotencyLedgerEntry {
  return {
    status: asString(input.status, 'completed'),
    evidenceRefs: Array.isArray(input.evidenceRefs)
      ? input.evidenceRefs.map((ref) => asString(ref)).filter(Boolean)
      : [],
    toolCallId: asString(input.toolCallId) || undefined,
    toolName: asString(input.toolName) || undefined,
    updatedAt: new Date().toISOString(),
    planId: asString(input.planId) || undefined,
    runId: asString(input.runId) || undefined,
  };
}

function sanitizePathSegment(value: string): string {
  const raw = asString(value) || 'unknown';
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

/**
 * Resolve durable ledger file path:
 *   {storeDir}/idempotency/{planId}/{runId}.json
 */
export function resolveGoalIdempotencyLedgerPath(input: {
  readonly storeDir: string;
  readonly planId: string;
  readonly runId: string;
}): string {
  const storeDir = asString(input.storeDir);
  const planId = sanitizePathSegment(input.planId);
  const runId = sanitizePathSegment(input.runId);
  return path.join(storeDir, 'idempotency', planId, `${runId}.json`);
}

function loadDurableEntries(filePath: string): Map<string, GoalIdempotencyLedgerEntry> {
  const entries = new Map<string, GoalIdempotencyLedgerEntry>();
  try {
    if (!existsSync(filePath)) return entries;
    const raw = readFileSync(filePath, 'utf8');
    if (!raw.trim()) return entries;
    const parsed = JSON.parse(raw) as {
      entries?: Record<string, GoalIdempotencyLedgerEntry>;
    };
    if (!parsed?.entries || typeof parsed.entries !== 'object') return entries;
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (!key || !value || typeof value !== 'object') continue;
      entries.set(key, {
        status: asString(value.status, 'completed'),
        evidenceRefs: Array.isArray(value.evidenceRefs)
          ? value.evidenceRefs.map((ref) => asString(ref)).filter(Boolean)
          : [],
        toolCallId: asString(value.toolCallId) || undefined,
        toolName: asString(value.toolName) || undefined,
        updatedAt: asString(value.updatedAt) || new Date().toISOString(),
        planId: asString(value.planId) || undefined,
        runId: asString(value.runId) || undefined,
      });
    }
  } catch {
    // Corrupt / partial file: start empty rather than crash tool path.
  }
  return entries;
}

function persistDurableEntries(
  filePath: string,
  meta: { planId: string; runId: string },
  entries: Map<string, GoalIdempotencyLedgerEntry>,
): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const payload = {
    version: 1,
    planId: meta.planId,
    runId: meta.runId,
    updatedAt: new Date().toISOString(),
    entries: Object.fromEntries(entries.entries()),
  };
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
}

/**
 * Durable Goal idempotency ledger, scoped by planId + runId.
 * Survives process restart so compact/resume cannot re-fire completed side effects.
 */
export function createDurableGoalIdempotencyLedger(input: {
  readonly storeDir: string;
  readonly planId: string;
  readonly runId: string;
  readonly ledgerPath?: string;
}) {
  const planId = asString(input.planId);
  const runId = asString(input.runId);
  const storeDir = asString(input.storeDir);
  if (!storeDir || !planId || !runId) {
    // Fallback to process-local when identity is incomplete.
    return createGoalIdempotencyLedger();
  }

  const filePath = asString(input.ledgerPath)
    || resolveGoalIdempotencyLedgerPath({ storeDir, planId, runId });
  const entries = loadDurableEntries(filePath);

  return {
    get(key: string) {
      return entries.get(key) ?? null;
    },
    remember(rememberInput: {
      readonly idempotencyKey: string;
      readonly status: string;
      readonly evidenceRefs?: readonly string[];
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly planId?: string;
      readonly runId?: string;
    }) {
      const key = asString(rememberInput.idempotencyKey);
      if (!key) return null;
      const next = createLedgerEntry({
        ...rememberInput,
        planId: rememberInput.planId || planId,
        runId: rememberInput.runId || runId,
      });
      entries.set(key, next);
      try {
        persistDurableEntries(filePath, { planId, runId }, entries);
      } catch {
        // Disk write must never fail the tool return path; in-memory still holds.
      }
      return next;
    },
    snapshot() {
      return new Map(entries);
    },
    clear() {
      entries.clear();
      try {
        if (existsSync(filePath)) {
          writeFileSync(
            filePath,
            `${JSON.stringify({
              version: 1,
              planId,
              runId,
              updatedAt: new Date().toISOString(),
              entries: {},
            }, null, 2)}\n`,
            'utf8',
          );
        }
      } catch {
        // ignore
      }
    },
    get filePath() {
      return filePath;
    },
  };
}
