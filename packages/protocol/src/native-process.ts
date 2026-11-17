import type { SessionControlOperation } from './session-control.ts';
import { normalizeSessionExecutionIdentity, type SessionExecutionIdentity } from './session-control.ts';
type Recorder = NonNullable<SessionControlOperation['recorder']>;
export interface NativeOwnedProcess {
  readonly schemaVersion: 1;
  readonly kind: 'command';
  readonly handleId: string;
  readonly toolCallId: string;
  readonly dispatchId: string;
  readonly execution: SessionExecutionIdentity;
  readonly generation: number;
  readonly state: 'not_started' | 'starting' | 'running' | 'ended';
  readonly owner: Recorder;
  readonly child?: Recorder | null;
  readonly stopObservation?: 'owned_completion' | 'owner_dead_not_started' | 'owner_dead_group_absent' | null;
}
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown, bytes: number) => typeof v === 'string' && v.length > 0 && v.length <= bytes && new TextEncoder().encode(v).length <= bytes;
const recorder = (v: unknown) => {
  const r = object(v);
  return Number.isInteger(r.pid) && (r.pid as number) > 0 && (r.pid as number) <= 2147483647
    && ['bootId', 'pidStart', 'hostId', 'acquiredAt'].every(k => text(r[k], 8192));
};
/** Shape only: no value here proves local execution or process death. */
export function nativeProcessesInWork(work: unknown): readonly NativeOwnedProcess[] {
  const budget = object(object(work).budget);
  const rows = [...Object.values(object(budget.attempts)).flatMap(a => {
    const pending = object(a).pendingTools; return Array.isArray(pending) ? pending : [];
  }), ...(Array.isArray(budget.uncertainDispatches) ? budget.uncertainDispatches : [])];
  const result: NativeOwnedProcess[] = [];
  for (const raw of rows) {
    const row = object(raw);
    if (!Object.hasOwn(row, 'nativeProcess')) continue;
    const p = object(row.nativeProcess), owner = object(p.owner), child = object(p.child);
    const original = object(object(row.nativeRecorder).recorder);
    const keys = ['schemaVersion', 'kind', 'handleId', 'toolCallId', 'dispatchId', 'execution', 'generation', 'state', 'owner', 'child', 'stopObservation'];
    const execution = normalizeSessionExecutionIdentity(p.execution);
    const recordedExecution = normalizeSessionExecutionIdentity(object(row.nativeRecorder).execution);
    const validChild = p.child == null || recorder(child) && ['hostId', 'acquiredAt', 'bootId'].every(k => child[k] === owner[k]);
    const gen = Number.isInteger(p.generation) && (p.generation as number) >= 0 && (p.generation as number) <= 64;
    const phase = p.state === 'not_started' ? p.generation === 0 && p.child == null && p.stopObservation == null
      : p.state === 'starting' ? (p.generation as number) > 0 && p.child == null && p.stopObservation == null
      : p.state === 'running' ? (p.generation as number) > 0 && p.child != null && p.stopObservation == null
      : p.state === 'ended' && (p.stopObservation === 'owned_completion'
        || p.stopObservation === 'owner_dead_not_started' && p.generation === 0 && p.child == null
        || p.stopObservation === 'owner_dead_group_absent' && (p.generation as number) > 0 && p.child != null);
    if (p.schemaVersion !== 1 || p.kind !== 'command' || Object.keys(p).some(k => !keys.includes(k))
      || !['handleId', 'toolCallId', 'dispatchId'].every(k => text(p[k], 200))
      || !gen || !phase || !recorder(owner) || !recorder(original) || !validChild || !execution || !recordedExecution
      || JSON.stringify(execution) !== JSON.stringify(recordedExecution)
      || !['pid', 'pidStart', 'bootId', 'hostId', 'acquiredAt'].every(k => owner[k] === original[k])
      || p.toolCallId !== row.toolCallId || p.dispatchId !== row.dispatchId || result.length >= 128
      || result.some(old => old.handleId === p.handleId || old.toolCallId === p.toolCallId || old.dispatchId === p.dispatchId)) {
      throw new Error('native_process_invalid');
    }
    result.push(structuredClone(p) as unknown as NativeOwnedProcess);
  }
  return result;
}
