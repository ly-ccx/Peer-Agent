import { readFileSync, writeFileSync, renameSync } from 'node:fs';

/** Test-only host receipts: the driver controls stages after checking production UI. */
export async function controlledCancelSession({ file, payload, getSessions, setSessions, queueChanged, timeoutMs = 120_000 }) {
  const persist = value => { writeFileSync(file + '.cancel-next', JSON.stringify(value)); renameSync(file + '.cancel-next', file); };
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const sequence = (state.cancelCalls?.length ?? 0) + 1;
  persist({ ...state, cancelCalls: [...(state.cancelCalls ?? []), payload] });
  const wait = async key => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (JSON.parse(readFileSync(file, 'utf8'))[key]?.includes(sequence)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error(`Controlled cancellation ${sequence} was not advanced at ${key}`);
  };
  if (state.cancelHandshake) await wait('cancelRelease');
  else await new Promise(resolve => setTimeout(resolve, 650));
  if (state.cancelMode === 'fail') return { ok: false, code: 'CONTROLLED_CANCEL_FAILURE' };
  const session = getSessions().find(item => item.sessionId === payload.sessionId);
  if (!session) return { ok: false, code: 'NOT_FOUND' };
  const deferred = state.cancelMode === 'deferred-status';
  const next = { ...session, status: deferred ? 'stopping' : 'cancelled', statusLabel: deferred ? '正在停止' : '已取消' };
  setSessions(getSessions().map(item => item.sessionId === payload.sessionId ? next : item));
  queueChanged(payload.workspaceId);
  const finish = () => {
    setSessions(getSessions().map(item => item.sessionId === payload.sessionId && item.status === 'stopping'
      ? { ...item, status: 'cancelled', statusLabel: '已取消' } : item));
    queueChanged(payload.workspaceId);
  };
  if (deferred) {
    if (state.cancelHandshake) void wait('cancelFinalize').then(finish).catch(error => {
      // Surface a fixture failure to the driver without mutating a completed request.
      const current = JSON.parse(readFileSync(file, 'utf8'));
      persist({ ...current, cancelFixtureError: error.message });
    });
    else setTimeout(finish, 500);
  }
  return { ok: true, session: next };
}
