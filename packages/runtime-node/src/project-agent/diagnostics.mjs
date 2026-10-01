import { createHash } from 'node:crypto';
import path from 'node:path';

const enumOf = (value, values) => values.includes(value) ? value : 'unknown';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const rows = value => Array.isArray(value) ? value : [];
export function diagnosticText(value) {
  if (typeof value !== 'string') return null;
  return { length: value.length, sha256: createHash('sha256').update(value).digest('hex') };
}
function relativePaths(value) {
  return rows(value).filter(item => typeof item === 'string' && item.length <= 500 && item.length > 0
    && !path.posix.isAbsolute(item) && !path.win32.isAbsolute(item) && !item.includes('\\')
    && !item.split('/').includes('..') && !/[\r\n\0]/.test(item)
    && !/\b(?:sk|pk|rk)-[A-Za-z0-9]{8,}|Bearer\s|(?:api[_-]?key|token|secret|password)\s*[=:]/i.test(item));
}
function timing(message) {
  const t = message?.meta?.diagnosticTiming, startedAt = iso(t?.startedAt), finishedAt = iso(t?.finishedAt);
  const valid = startedAt && finishedAt && Date.parse(finishedAt) >= Date.parse(startedAt)
    && Number.isFinite(t?.durationMs) && t.durationMs >= 0 && ['done','error','preempted'].includes(t.outcome);
  return { identity: diagnosticText(message?.id), startedAt: valid ? startedAt : null, finishedAt: valid ? finishedAt : null,
    durationMs: valid ? t.durationMs : null, outcome: valid ? t.outcome : 'unknown' };
}

/** Fresh read ports only. Every output field is admitted explicitly; no recursive/raw object export. */
export function createProjectDiagnostics({ readProjects, readLease, readInput, readInbox, readApprovals,
  readObjectives, readWatch, readTurns, readScheduler, now = () => new Date().toISOString() } = {}) {
  function read() {
    const errors = [];
    const attempt = (code, fn, fallback) => { try { return fn(); } catch { errors.push(code); return fallback; } };
    const projects = attempt('PROJECTS_UNAVAILABLE', () => rows(readProjects()), []);
    const scheduler = attempt('SCHEDULER_UNAVAILABLE', () => readScheduler(), null);
    const bots = projects.map(project => {
      const faults = [];
      const get = (code, fn, fallback = null) => { try { return fn(); } catch { faults.push(code); return fallback; } };
      const ws = project.workspaceId;
      const lease = get('LEASE_UNAVAILABLE', () => readLease(ws));
      const input = get('INPUT_UNAVAILABLE', () => readInput(ws));
      const inbox = get('INBOX_UNAVAILABLE', () => readInbox(ws));
      const approvals = get('APPROVALS_UNAVAILABLE', () => rows(readApprovals(ws)), []);
      const objectives = get('OBJECTIVES_UNAVAILABLE', () => rows(readObjectives(ws)), []);
      const turns = get('TURNS_UNAVAILABLE', () => rows(readTurns(ws)), []);
      return { identity: diagnosticText(ws), workspace: '.',
        lease: lease ? { holder: diagnosticText(lease.hostId), surface: enumOf(lease.surface, ['desktop','tui']),
          pid: count(lease.pid), acquiredAt: iso(lease.acquiredAt), heartbeatAt: iso(lease.heartbeatAt) } : null,
        input: input ? { depth: count(input.depth), executionDepth: count(input.executionDepth),
          cursor: diagnosticText(input.cursor), executedCursor: diagnosticText(input.executedCursor) } : null,
        inbox: inbox ? { cursor: count(inbox.cursor), events: rows(inbox.events).slice(-200).map(event => ({
          identity: diagnosticText(event.eventId), seq: count(event.seq), at: iso(event.at),
          kind: enumOf(event.kind, ['session_started','needs_user','result_ready','completed','failed','cancelled','superseded','user_intervened','stalled','progress','objective_signal']),
        })) } : null,
        approvals: approvals.filter(item => ['open','stale'].includes(item?.state)).map(item => ({ identity: diagnosticText(item.approvalId),
          state: item.state, capability: diagnosticText(item.capabilityId), summary: diagnosticText(item.summary), at: iso(item.createdAt) })),
        objectives: objectives.map(item => ({ identity: diagnosticText(item.objectiveId),
          status: enumOf(item.status, ['active','paused','achieved','abandoned']),
          autonomy: enumOf(item.autonomy, ['report_only','propose','act']),
          watches: rows(item.watches).map(watch => {
            const state = get('WATCH_UNAVAILABLE', () => readWatch(ws, item.objectiveId, watch.watchId), {});
            return { identity: diagnosticText(watch.watchId), kind: enumOf(watch.kind, ['schedule','event']),
              source: enumOf(watch.source?.type, ['git','files','task_event']), paths: relativePaths(watch.source?.paths),
              lastObservationAt: iso(state?.lastObservationAt), nextRunAt: iso(state?.nextRunAt),
              pending: Boolean(state?.pendingExecutionKey || state?.pendingSignalExecutionKey), unavailable: Boolean(state?.unavailableReason) };
          }),
        })), turns: turns.filter(item => item?.kind === 'agent_turn').slice(-20).map(timing), errors: [...new Set(faults)] };
    });
    return { schemaVersion: 1, generatedAt: iso(now()), scheduler: scheduler ? {
      stats: { active: count(scheduler.stats?.active), waiting: count(scheduler.stats?.waiting), limit: count(scheduler.stats?.limit) },
      queue: rows(scheduler.queue).map(job => ({ workspace: diagnosticText(job.workspaceId), plan: diagnosticText(job.planId),
        priority: enumOf(job.priority, ['high','normal','low']), enqueuedAt: iso(job.at) })),
      projects: rows(scheduler.projects).map(project => ({ workspace: diagnosticText(project.workspaceId),
        slots: { read: count(project.slots?.read), write: count(project.slots?.write), isolated: count(project.slots?.isolated) },
        queue: rows(project.queue).map(job => ({ session: diagnosticText(job.sessionId), priority: enumOf(job.priority, ['high','normal','low']),
          enqueuedAt: iso(job.enqueuedAt), reason: job.reason === null ? null : enumOf(job.reason, ['dependencies','dependency_missing','dependency_failed','read_slot','write_slot','isolated_slot']) })) })),
    } : null, bots, errors };
  }
  return { read };
}
