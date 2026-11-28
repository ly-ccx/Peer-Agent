import { isHookObservation } from './hook-observation.ts';
import { nativeProcessEnvelopeValid } from './native-process.ts';
import { normalizeSessionExecutionIdentity } from './session-control.ts';

export const WORK_HOOK_SEMANTIC_FLOOR = 14;
const maxHandles = 256;
const invalid = (): never => { throw new Error('native_work_hooks_invalid'); };
const record = (input: unknown): Record<string, unknown> | undefined =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
const requiredId = (input: unknown) => typeof input === 'string' && input.length > 0
  && new TextEncoder().encode(input).length <= 200;
const ownerKeys = ['pid', 'pidStart', 'bootId', 'hostId', 'acquiredAt'];

/** Shape only. OS observation, ownership and business effects require Host evidence. */
export function nativeWorkHasHookFacts(work: unknown): boolean {
  const budget = record(record(work)?.budget);
  const pending = Object.values(record(budget?.attempts) ?? {}).flatMap(attempt => {
    const pending = record(attempt)?.pendingTools;
    return Array.isArray(pending) ? pending : [];
  });
  const rows = pending.concat(Array.isArray(budget?.uncertainDispatches) ? budget.uncertainDispatches : []);
  const ids = new Set<unknown>();
  let found = false;
  for (const input of rows) {
    const row = record(input);
    if (!row || !Object.hasOwn(row, 'nativeHooks')) continue;
    const hooks = record(row.nativeHooks);
    const recorder = record(row.nativeRecorder);
    const owner = record(recorder?.recorder);
    const execution = normalizeSessionExecutionIdentity(recorder?.execution);
    const provider = record(row.nativeProcess);
    const intent = record(hooks?.intent);
    if (!hooks || Object.keys(hooks).some(key => !['schemaVersion', 'providerPhase', 'handles', 'intent', 'grant'].includes(key))
      || Object.hasOwn(hooks, 'intent') && (!intent || Object.keys(intent).length !== 2
        || !requiredId(intent.messageId) || /[\u0000-\u001f\u007f-\u009f]/u.test(intent.messageId as string)
        || typeof intent.argsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(intent.argsDigest))
      || hooks.schemaVersion !== 1
      || !['prepared', 'dispatching'].some(phase => phase === hooks.providerPhase)
      || !Array.isArray(hooks.handles) || hooks.handles.length > maxHandles
      || recorder?.schemaVersion !== 1 || recorder.runtime !== 'peer-native' || !owner || !execution
      || !Number.isInteger(owner.pid) || (owner.pid as number) <= 0 || (owner.pid as number) > 2147483647
      || ownerKeys.slice(1).some(key => typeof owner[key] !== 'string' || !(owner[key] as string).length
        || new TextEncoder().encode(owner[key] as string).length > 8192)
      || !requiredId(row.toolCallId) || !requiredId(row.dispatchId)
      || hooks.providerPhase === 'prepared' && Object.hasOwn(row, 'nativeProcess')) return invalid();
    if (Object.hasOwn(hooks, 'grant')) {
      const grant = record(hooks.grant);
      if (hooks.providerPhase !== 'dispatching' || !intent || !grant || grant.granted !== true
        || grant.toolCallId !== row.toolCallId || grant.duration !== 'once'
        || typeof grant.grantId !== 'string' || grant.grantId.length === 0) return invalid();
    }
    found = true;
    for (const input of hooks.handles) {
      const hook = record(input);
      const process = record(hook?.process);
      const processOwner = record(process?.owner);
      const processExecution = normalizeSessionExecutionIdentity(process?.execution);
      if (!hook || Object.keys(hook).some(key => !['event', 'ruleDigest', 'process', 'observation'].includes(key))
        || !['PreToolUse', 'PostToolUse'].some(event => event === hook.event)
        || hooks.providerPhase === 'prepared' && hook.event === 'PostToolUse'
        || typeof hook.ruleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(hook.ruleDigest)
        || !process || !nativeProcessEnvelopeValid(process) || !processOwner || !processExecution
        || ownerKeys.some(key => processOwner[key] !== owner[key])
        || JSON.stringify(processExecution) !== JSON.stringify(execution)
        || process.toolCallId !== row.toolCallId || process.dispatchId !== row.dispatchId
        || (process.generation as number) > 1
        || ids.size >= maxHandles || ids.has(process.handleId) || process.handleId === provider?.handleId
        || (process.stopObservation === 'owned_completion'
          ? !isHookObservation(hook.observation, hook.event, hook.ruleDigest, process.handleId)
          : Object.hasOwn(hook, 'observation'))) return invalid();
      ids.add(process.handleId);
    }
  }
  return found;
}
