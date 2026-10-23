import { emptyInputDraft, projectInputWasReceived, type InputDraftValue, type LocalInputSurface,
  type ProjectAgentSubmitInputResult, type ProjectInputDraftSnapshot, type ProjectInputRecoveryPort,
  type UnconfirmedProjectInput } from '@peer-agent/protocol';

export interface InputRecoveryView extends ProjectInputDraftSnapshot {
  readonly ready: boolean;
  readonly error: string | null;
  readonly sending: readonly string[];
  readonly received: readonly UnconfirmedProjectInput[];
}
/** Presentation continuity only; ports own storage and the existing governed input queue. */
export function createProjectInputRecovery({ workspaceId, surface, port, createId, now = () => new Date().toISOString(), receiptTimeoutMs = 30_000 }: {
  workspaceId: string; surface: LocalInputSurface; port: ProjectInputRecoveryPort; createId: () => string; now?: () => string; receiptTimeoutMs?: number;
}) {
  const address = { workspaceId, surface };
  let view: InputRecoveryView = { revision: 0, draft: emptyInputDraft(), pending: [], ready: false, error: null, sending: [], received: [] };
  let changed = 0, saved = 0;
  let earlyEdits: Partial<InputDraftValue> | null = null;
  let writing: Promise<boolean> | null = null, loading: Promise<boolean> | null = null;
  const listeners = new Set<() => void>(), storedAttachments = new Map<string, import('@peer-agent/protocol').ProjectInputAttachment>(), active = new Map<string, Promise<ProjectAgentSubmitInputResult>>();
  const publish = (patch: Partial<InputRecoveryView>) => { view = { ...view, ...patch }; for (const fn of listeners) fn(); };
  async function load(): Promise<boolean> {
    if (loading) return loading;
    loading = (async () => {
      try {
        const result = await port.read(address);
        if (!result.ok) { publish({ error: result.code }); return false; }
        for (const item of [...result.snapshot.draft.attachments, ...result.snapshot.pending.flatMap(item => item.attachments)]) storedAttachments.set(item.id, item);
        publish({ ...result.snapshot, draft: earlyEdits ? { ...result.snapshot.draft, ...earlyEdits } : result.snapshot.draft, ready: true, error: null });
        if (earlyEdits) { earlyEdits = null; changed++; void flush(); }
        return true;
      } catch { publish({ error: 'DRAFT_UNAVAILABLE' }); return false; }
      finally { loading = null; }
    })();
    return loading;
  }
  async function flush(): Promise<boolean> {
    if (!view.ready) return false;
    if (writing) return writing;
    writing = (async () => {
      while (saved !== changed) {
        const version = changed, state = view;
        const all = [...state.draft.attachments, ...state.pending.flatMap(item => item.attachments)];
        const uploads = [...new Map(all.filter(item => storedAttachments.get(item.id) !== item).map(item => [item.id, item])).values()];
        const { attachments, ...draft } = state.draft;
        try {
          const result = await port.write({ ...address, revision: state.revision,
            draft: { ...draft, attachmentIds: attachments.map(item => item.id) },
            pending: state.pending.map(({ attachments, ...input }) => ({ ...input, attachmentIds: attachments.map(item => item.id) })), uploads });
          if (!result.ok) { publish({ error: result.code }); return false; }
          saved = version;
          storedAttachments.clear();
          for (const item of all) storedAttachments.set(item.id, item);
          publish({ revision: result.revision, error: null });
        } catch { publish({ error: 'DRAFT_SAVE_FAILED' }); return false; }
      }
      return true;
    })().finally(() => { writing = null; });
    return writing;
  }
  function edit(patch: Partial<InputDraftValue>) {
    if (!view.ready) earlyEdits = { ...earlyEdits, ...patch };
    changed++; publish({ draft: { ...view.draft, ...patch } });
    if (view.ready) void flush();
  }
  function acknowledge(ids: readonly string[]) {
    const pending = view.pending.filter(item => !ids.includes(item.inputId));
    if (pending.length === view.pending.length) return;
    const received = [...view.received, ...view.pending.filter(item => ids.includes(item.inputId))];
    changed++; publish({ pending, received }); void flush();
  }
  function dispatch(input: UnconfirmedProjectInput): Promise<ProjectAgentSubmitInputResult> {
    const running = active.get(input.inputId); if (running) return running;
    const job = (async () => {
      publish({ sending: [...view.sending, input.inputId] });
      try {
        if (!await flush()) return { ok: false, code: view.error || 'DRAFT_SAVE_FAILED' };
        // This deadline ends the presentation wait, never the host operation. A late
        // factual receipt still reconciles the original envelope without resending.
        const submitted = port.submit({ ...address, ...input }).then(result => {
          if (projectInputWasReceived(result, workspaceId, input.inputId)) { acknowledge([input.inputId]); return result; }
          return { ok: false, code: result.code || 'INPUT_OUTCOME_UNKNOWN' };
        }).catch(() => ({ ok: false, code: 'INPUT_OUTCOME_UNKNOWN' }));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([submitted, new Promise<ProjectAgentSubmitInputResult>(resolve => {
            timer = setTimeout(() => resolve({ ok: false, code: 'INPUT_OUTCOME_UNKNOWN' }), receiptTimeoutMs);
          })]);
        } finally { clearTimeout(timer); }
      } catch { return { ok: false, code: 'INPUT_OUTCOME_UNKNOWN' }; }
      finally { active.delete(input.inputId); publish({ sending: view.sending.filter(id => id !== input.inputId) }); }
    })();
    active.set(input.inputId, job); return job;
  }
  async function send(options: { text?: string; quoteRefs?: readonly string[]; answerTo?: string; useDraft?: boolean } = {}): Promise<ProjectAgentSubmitInputResult> {
    if (!view.ready && !await load()) return { ok: false, code: view.error || 'DRAFT_UNAVAILABLE' };
    const useDraft = options.useDraft !== false, draft = view.draft;
    const text = (options.text ?? draft.text).trim(), attachments = useDraft ? draft.attachments : [];
    if (useDraft && options.text !== undefined && text !== draft.text.trim()) return { ok: false, code: 'INPUT_CHANGED' };
    if (!text && !attachments.length) return { ok: false, code: 'INVALID_INPUT' };
    if (!useDraft && options.answerTo) {
      const existing = view.pending.find(item => item.answerTo === options.answerTo);
      if (existing) return existing.text === text ? dispatch(existing) : { ok: false, code: 'INPUT_PENDING_ANSWER' };
    }
    if (view.pending.length >= 32) return { ok: false, code: 'DRAFT_LIMIT' };
    const input = { inputId: createId(), text, attachments, createdAt: now(), quoteRefs: options.quoteRefs ?? [],
      ...(options.answerTo ? { answerTo: options.answerTo } : {}) };
    changed++; publish({ pending: [...view.pending, input], ...(useDraft ? { draft: emptyInputDraft() } : {}) });
    return dispatch(input);
  }
  return {
    getSnapshot: () => view,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    load, edit, flush, acknowledge, send,
    observeReceived(ids: readonly string[]) {
      const pending = view.pending.filter(item => !ids.includes(item.inputId));
      const received = view.received.filter(item => !ids.includes(item.inputId));
      if (pending.length !== view.pending.length) { changed++; publish({ pending, received }); void flush(); }
      else if (received.length !== view.received.length) publish({ received });
    },
    retry(inputId: string) { const input = view.pending.find(item => item.inputId === inputId); return input ? dispatch(input) : Promise.resolve({ ok: false, code: 'INPUT_NOT_PENDING' }); },
  };
}
export type ProjectInputRecovery = ReturnType<typeof createProjectInputRecovery>;
