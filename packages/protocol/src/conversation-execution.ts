/** Ordinary execution facts in the original Conversation index. Shape is never
 * permission, process-death proof, or authority to replay a pending dispatch. */
import { normalizeExecutionResourceScope, type SessionControlOperation } from './session-control.ts';
import { isHookObservation } from './hook-observation.ts';
import { nativeProcessEnvelopeValid } from './native-process.ts';
type Recorder = NonNullable<SessionControlOperation['recorder']>;
export interface ConversationExecutionIdentity {
  readonly kind: 'conversation';
  readonly conversationId: string;
  readonly streamId: string;
}
export interface ConversationExecution {
  readonly schemaVersion: 1;
  readonly identity: ConversationExecutionIdentity;
  readonly engine: 'peer-native' | 'peer-ts';
  readonly owner: Recorder;
  readonly revision: number;
  readonly phase: 'active' | 'stopping' | 'stopped' | 'recovery_required';
  readonly pendingTools: readonly {
    readonly toolCallId: string; readonly dispatchId: string; readonly messageId: string;
    readonly capabilityId: string; readonly argsDigest: string;
    readonly phase: 'prepared' | 'dispatching' | 'outcome_unknown';
    readonly declaredScopes: readonly unknown[];
    readonly nativeProcess?: unknown;
  }[];
  readonly handles: readonly { readonly handleId: string; readonly toolCallId: string;
    readonly state: 'active' | 'ended'; readonly metadata: Readonly<Record<string, unknown>> }[];
  readonly usage: null | { readonly usageScope: 'runtime_turn'; readonly providerRequestCount: number;
    readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number; readonly totalTokens: number };
  readonly unknownUsage: boolean;
  readonly attribution: Readonly<Record<string, unknown>>;
  readonly usageCommitted: boolean;
  readonly stop?: { readonly owner: Recorder; readonly observedAt: string; readonly runnerIdle: true;
    readonly admissionClosed: true; readonly handlesEnded: true } | null;
  readonly updatedAt: string;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0
  && new TextEncoder().encode(v).length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const recorderKeys = ['bootId', 'pid', 'pidStart', 'hostId', 'acquiredAt'];
const recorder = (v: unknown): v is Recorder => object(v) && Object.keys(v).length === 5 && keys(v, recorderKeys)
  && Number.isInteger(v.pid) && (v.pid as number) > 0 && (v.pid as number) <= 2147483647
  && recorderKeys.filter(k => k !== 'pid').every(k => typeof v[k] === 'string' && (v[k] as string).length > 0
    && new TextEncoder().encode(v[k] as string).length <= 8192);
const sameRecorder = (a: Recorder, b: Recorder) => recorderKeys.every(k => a[k as keyof Recorder] === b[k as keyof Recorder]);
const safe = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const amountKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const identity = (v: unknown): v is ConversationExecutionIdentity => object(v)
  && Object.keys(v).length === 3 && keys(v, ['kind', 'conversationId', 'streamId']) && v.kind === 'conversation'
  && typeof v.conversationId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v.conversationId) && text(v.streamId, 200);
function equalsRecord(a: unknown, b: unknown): boolean {
  if (!object(a) || !object(b)) return a === b;
  const fields = Object.keys(a);
  return fields.length === Object.keys(b).length && fields.every(k => Object.hasOwn(b, k) && equalsRecord(a[k], b[k]));
}
function validBackgroundShellHandle(
  h: Record<string, unknown>, metadata: Record<string, unknown>, run: Record<string, unknown>,
  runIdentity: ConversationExecutionIdentity, owner: Recorder, pending: readonly unknown[],
): boolean {
  const shell = metadata.nativeShell;
  if (run.engine !== 'peer-native' || Object.keys(metadata).length !== 2 || !object(shell)
    || Object.keys(shell).length !== 2 || shell.schemaVersion !== 1) return false;
  const process = shell.process;
  if (!object(process) || !nativeProcessEnvelopeValid(process) || !recorder(process.owner) || !sameRecorder(process.owner, owner)
    || !identity(process.execution) || !equalsRecord(process.execution, runIdentity)
    || typeof process.handleId !== 'string' || !/^shell_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(process.handleId)
    || !process.handleId.startsWith('shell_') || (process.generation as number) > 1
    || process.child != null && (!recorder(process.child) || process.child.pid === owner.pid)
    || h.handleId !== process.handleId || h.toolCallId !== process.toolCallId
    || h.state !== (process.state === 'ended' ? 'ended' : 'active')) return false;
  return pending.some(call => {
    if (!object(call) || !object(call.nativeProcess) || call.toolCallId !== process.toolCallId || call.dispatchId !== process.dispatchId
      || call.capabilityId !== 'local.shell.exec' || call.phase === 'prepared') return false;
    const comparable = (value: Record<string, unknown>) => ({
      ...value, child: value.child ?? null, stopObservation: value.stopObservation ?? null,
    });
    return equalsRecord(comparable(call.nativeProcess), comparable(process));
  });
}
function validPersistentShellHandle(
  h: Record<string, unknown>, metadata: Record<string, unknown>,
  runIdentity: ConversationExecutionIdentity, owner: Recorder, pending: readonly unknown[],
): boolean {
  const session = metadata.nativeShellSession;
  if (Object.keys(metadata).length !== 2 || !object(session)
    || Object.keys(session).length !== 3 || !keys(session, ['schemaVersion', 'process', 'command'])
    || session.schemaVersion !== 1 || !Object.hasOwn(session, 'command')) return false;
  const process = session.process;
  if (!object(process) || !nativeProcessEnvelopeValid(process) || !recorder(process.owner)
    || !sameRecorder(process.owner, owner) || !identity(process.execution) || !equalsRecord(process.execution, runIdentity)
    || typeof process.handleId !== 'string' || !process.handleId.startsWith('shell-session_')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(process.handleId.slice('shell-session_'.length))
    || (process.generation as number) > 1 || process.child != null && (!recorder(process.child) || process.child.pid === owner.pid)
    || h.handleId !== process.handleId || h.toolCallId !== process.toolCallId
    || h.state !== (process.state === 'ended' ? 'ended' : 'active')) return false;
  const bound = (callId: unknown, dispatchId: unknown): boolean => pending.some(call =>
    object(call) && call.toolCallId === callId && call.dispatchId === dispatchId
      && call.capabilityId === 'local.shell.exec' && call.phase !== 'prepared' && call.nativeProcess == null);
  if ((process.state === 'not_started' || process.state === 'starting')
    && !bound(process.toolCallId, process.dispatchId)) return false;
  const command = session.command;
  return command === null || object(command) && Object.keys(command).length === 3
    && keys(command, ['toolCallId', 'dispatchId', 'generation'])
    && ['running', 'ended'].some(state => state === process.state) && process.child != null
    && command.generation === process.generation && bound(command.toolCallId, command.dispatchId);
}
function validHookHandle(
  h: Record<string, unknown>, metadata: Record<string, unknown>,
  runIdentity: ConversationExecutionIdentity, owner: Recorder, pending: readonly unknown[],
): boolean {
  const hook = metadata.nativeHook;
  if (Object.keys(metadata).length !== 2 || !object(hook)
    || !keys(hook, ['schemaVersion', 'event', 'ruleDigest', 'process', 'observation'])
    || hook.schemaVersion !== 1 || !['PreToolUse', 'PostToolUse'].some(v => v === hook.event)
    || typeof hook.ruleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(hook.ruleDigest)) return false;
  const p = hook.process;
  if (!object(p) || !nativeProcessEnvelopeValid(p) || !recorder(p.owner)
    || !sameRecorder(p.owner, owner) || !identity(p.execution)
    || p.execution.conversationId !== runIdentity.conversationId || p.execution.streamId !== runIdentity.streamId
    || p.handleId !== h.handleId || p.toolCallId !== h.toolCallId
    || h.state !== (p.state === 'ended' ? 'ended' : 'active')
    || !safe(p.generation) || p.generation > 1 || p.child != null && !recorder(p.child)
    || !pending.some(row => object(row) && row.toolCallId === p.toolCallId && row.dispatchId === p.dispatchId
      && (hook.event === 'PreToolUse' || row.phase !== 'prepared'))) return false;
  if (p.stopObservation !== 'owned_completion') return !Object.hasOwn(hook, 'observation');

  return isHookObservation(hook.observation, hook.event, hook.ruleDigest, p.handleId);
}
/** Strict decoding: unknown versions/fields are preserved by the caller and block
 * execution. Return a clone so a parser consumer cannot change the stored fact. */
export function normalizeConversationExecution(raw: unknown): ConversationExecution {
  const invalid = (): never => { throw new Error('conversation_execution_invalid'); };
  if (!object(raw) || !keys(raw, ['schemaVersion', 'identity', 'engine', 'owner', 'revision', 'phase', 'pendingTools',
    'handles', 'usage', 'unknownUsage', 'attribution', 'usageCommitted', 'stop', 'updatedAt'])
    || raw.schemaVersion !== 1 || !identity(raw.identity) || !recorder(raw.owner)
    || !['peer-native', 'peer-ts'].some(v => v === raw.engine) || !safe(raw.revision) || raw.revision < 1
    || !['active', 'stopping', 'stopped', 'recovery_required'].some(v => v === raw.phase)
    || !text(raw.updatedAt, 64) || typeof raw.unknownUsage !== 'boolean' || typeof raw.usageCommitted !== 'boolean'
    || !Array.isArray(raw.pendingTools) || raw.pendingTools.length > 128 || !Array.isArray(raw.handles) || raw.handles.length > 128
    || !Object.hasOwn(raw, 'usage') || !object(raw.attribution) || raw.attribution.id !== raw.identity.streamId) return invalid();
  const at = raw.attribution;
  if (!keys(at, ['id', 'at', 'streamId', 'modelProviderId', 'groupId', 'model', 'providerName', 'role', 'workspaceId', 'estimatedCostUsd', 'pricingSource'])
    || Object.entries(at).some(([k,v]) => v !== null && (k === 'estimatedCostUsd'
      ? typeof v !== 'number' || !Number.isFinite(v) || v < 0 : !text(v, 200)))
    || Object.hasOwn(at, 'streamId') && at.streamId !== raw.identity.streamId
    || at.role != null && at.role !== 'chat') return invalid();
  if (raw.usage !== null) {
    const u = raw.usage;
    if (!object(u) || Object.keys(u).length !== 7 || !keys(u, ['usageScope', 'providerRequestCount', ...amountKeys, 'totalTokens'])
      || u.usageScope !== 'runtime_turn' || !safe(u.providerRequestCount) || !safe(u.totalTokens)
      || !amountKeys.every(k => safe(u[k])) || amountKeys.reduce((n,k) => n + (u[k] as number), 0) !== u.totalTokens
      || u.totalTokens > 0 && u.providerRequestCount === 0) return invalid();
  }
  if (raw.stop != null) {
    const s = raw.stop;
    if (!object(s) || !keys(s, ['owner', 'observedAt', 'runnerIdle', 'admissionClosed', 'handlesEnded']) || !recorder(s.owner)
      || !sameRecorder(s.owner, raw.owner) || !text(s.observedAt, 64) || s.runnerIdle !== true || s.admissionClosed !== true
      || s.handlesEnded !== true || ['active', 'stopping'].some(v => v === raw.phase)) return invalid();
  } else if (raw.phase === 'stopped') return invalid();
  if (raw.phase === 'stopped' && (raw.pendingTools.length !== 0 || !raw.usageCommitted)) return invalid();
  const seen = [new Set<string>(), new Set<string>(), new Set<string>()];
  for (const p of raw.pendingTools) {
    if (!object(p) || !keys(p, ['toolCallId', 'dispatchId', 'messageId', 'capabilityId', 'argsDigest', 'phase', 'declaredScopes', 'nativeProcess'])
      || !['toolCallId', 'dispatchId', 'messageId', 'capabilityId'].every(k => text(p[k], 200))
      || typeof p.argsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(p.argsDigest)
      || !['prepared', 'dispatching', 'outcome_unknown'].some(v => v === p.phase) || !Array.isArray(p.declaredScopes)
      || p.declaredScopes.length > 32 || p.declaredScopes.some(s => !normalizeExecutionResourceScope(s))) return invalid();
    for (const [i,k] of ['toolCallId', 'dispatchId', 'messageId'].entries()) {
      const v = p[k] as string; if (seen[i]!.has(v)) return invalid(); seen[i]!.add(v);
    }
    if (p.nativeProcess != null) {
      const n = p.nativeProcess;
      if (p.phase === 'prepared' || !object(n) || !nativeProcessEnvelopeValid(n) || !recorder(n.owner)
        || !sameRecorder(n.owner, raw.owner) || !identity(n.execution) || n.execution.conversationId !== raw.identity.conversationId
        || n.execution.streamId !== raw.identity.streamId || n.toolCallId !== p.toolCallId || n.dispatchId !== p.dispatchId
        || n.child != null && !recorder(n.child)) return invalid();
    }
  }
  const handles = new Set<string>();
  let shellSessionSeen = false;
  for (const h of raw.handles) {
    if (!object(h) || Object.keys(h).length !== 4 || !keys(h, ['handleId', 'toolCallId', 'state', 'metadata'])
      || !text(h.handleId, 512) || handles.has(h.handleId) || !text(h.toolCallId, 200) || !object(h.metadata)
      || !['active', 'ended'].some(v => v === h.state) || raw.phase === 'stopped' && h.state !== 'ended') return invalid();
    if (h.metadata.kind === 'hook' && !validHookHandle(h, h.metadata, raw.identity, raw.owner, raw.pendingTools)) return invalid();
    if (h.metadata.kind === 'shell_background' && !validBackgroundShellHandle(h, h.metadata, raw, raw.identity, raw.owner, raw.pendingTools)) return invalid();
    if (h.metadata.kind === 'shell_session') {
      if (shellSessionSeen || !validPersistentShellHandle(h, h.metadata, raw.identity, raw.owner, raw.pendingTools)) return invalid();
      shellSessionSeen = true;
    }
    handles.add(h.handleId);
  }
  return structuredClone(raw) as unknown as ConversationExecution;
}
export function conversationExecutionPermitsNewRun(raw: unknown): boolean {
  const r = normalizeConversationExecution(raw);
  return r.phase === 'stopped' && r.pendingTools.length === 0 && r.usageCommitted;
}
