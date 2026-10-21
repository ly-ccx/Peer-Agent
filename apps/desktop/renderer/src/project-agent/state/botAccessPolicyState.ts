import type { BotAccessPolicyReadRequest, BotAccessPolicyResult, LocalAccessLevel } from '@peer-agent/protocol';

export interface AccessControlSnapshot {
  readonly view: Extract<BotAccessPolicyResult, { ok: true }> | null;
  readonly busy: boolean;
  readonly error: boolean;
  readonly loading: boolean;
}

/** Owns stale reads, commit ordering and failure rollback; rendered choices are host receipts. */
export function createBotAccessPolicyState({ request, read, write, publish }: {
  request: BotAccessPolicyReadRequest;
  read: (request: BotAccessPolicyReadRequest) => Promise<BotAccessPolicyResult>;
  write: (request: { workspaceId: string; expectedRevision: number; accessLevel: LocalAccessLevel }) => Promise<BotAccessPolicyResult>;
  publish: (state: AccessControlSnapshot) => void;
}) {
  let alive = true, serial = 0, refreshAfterSave = false;
  let state: AccessControlSnapshot = { view: null, busy: false, error: false, loading: true };
  const emit = (patch: Partial<AccessControlSnapshot>) => { state = { ...state, ...patch }; if (alive) publish(state); };
  async function refresh() {
    if (!alive) return;
    if (state.busy) { refreshAfterSave = true; return; }
    const ticket = ++serial;
    try {
      const result = await read(request);
      if (!alive || ticket !== serial) return;
      if (result.ok) emit({ view: result, loading: false, error: false });
      else if (result.code === 'PROJECT_AGENT_DISABLED' && request.conversationId) emit({ view: { ok: true, policy: null, inherited: false }, loading: false, error: false });
      else emit({ error: true, loading: false });
    } catch { if (alive && ticket === serial) emit({ error: true, loading: false }); }
  }
  async function save(accessLevel: LocalAccessLevel) {
    const view = state.view;
    if (!alive || state.busy || !view?.policy || view.inherited) return;
    ++serial;
    emit({ busy: true, error: false });
    try {
      const result = await write({ workspaceId: view.policy.workspaceId, expectedRevision: view.policy.revision, accessLevel });
      if (!alive) return;
      if (result.ok) emit({ view: result, error: false });
      else emit({ error: true, ...(result.policy ? { view: { ...view, policy: result.policy } } : {}) });
    } catch { if (alive) emit({ error: true }); }
    finally {
      if (alive) {
        emit({ busy: false });
        if (refreshAfterSave) { refreshAfterSave = false; await refresh(); }
      }
    }
  }
  return { refresh, save, stop() { alive = false; serial++; } };
}
