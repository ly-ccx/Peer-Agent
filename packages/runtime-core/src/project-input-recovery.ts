import { encodeResourceFeedbackTransport, normalizeResourceFeedbackList, emptyInputDraft, isDefiniteProjectInputRejection, projectInputWasReceived, type InputDraftValue, type LocalInputSurface,
  type ProjectAgentSubmitInputResult, type ProjectInputDraftSnapshot, type ProjectInputMutationResult, type ProjectInputRecoveryPort,
  type UnconfirmedProjectInput } from '@peer-agent/protocol';

export interface InputRecoveryView extends ProjectInputDraftSnapshot {
  readonly ready: boolean;
  readonly error: string | null;
  readonly sending: readonly string[];
  readonly received: readonly UnconfirmedProjectInput[];
  readonly rejected: Readonly<Record<string, string>>;
  readonly mutating: readonly string[];
}
const EMPTY_REJECTED: Readonly<Record<string, string>> = Object.freeze({});
const EMPTY_IDS: readonly string[] = Object.freeze([]);
const RESOURCE_REJECTION_CODES = new Set([
  'INVALID_RESOURCE_FEEDBACK',
  'RESOURCE_FEEDBACK_RECIPIENT_CHANGED',
  'RESOURCE_FEEDBACK_ATTACHMENT_LIMIT',
  'INTERACTIVE_FEEDBACK_UNAVAILABLE',
]);
const DRAFT_UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;
function estimateUploadBytes(item: import('@peer-agent/protocol').ProjectInputAttachment): number {
  const body = item.kind === 'image' ? item.dataUrl.length : item.kind === 'text' ? item.text.length : 0;
  return body + 512;
}
function partitionUploadChunks(uploads: readonly import('@peer-agent/protocol').ProjectInputAttachment[]): readonly (readonly import('@peer-agent/protocol').ProjectInputAttachment[])[] {
  if (uploads.length <= 1) return [uploads];
  const chunks: import('@peer-agent/protocol').ProjectInputAttachment[][] = [];
  let current: import('@peer-agent/protocol').ProjectInputAttachment[] = [];
  let currentBytes = 0;
  for (const item of uploads) {
    const bytes = estimateUploadBytes(item);
    if (current.length > 0 && currentBytes + bytes > DRAFT_UPLOAD_CHUNK_BYTES) {
      chunks.push(current);
      current = [item];
      currentBytes = bytes;
    } else {
      current.push(item);
      currentBytes += bytes;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Presentation continuity only; ports own storage and the existing governed input queue. */
export function createProjectInputRecovery({ workspaceId, surface, port, createId, now = () => new Date().toISOString(), receiptTimeoutMs = 30_000 }: {
  workspaceId: string; surface: LocalInputSurface; port: ProjectInputRecoveryPort; createId: () => string; now?: () => string; receiptTimeoutMs?: number;
}) {
  const address = { workspaceId, surface };
  let view: InputRecoveryView = { revision: 0, draft: emptyInputDraft(), pending: [], ready: false, error: null, sending: EMPTY_IDS, received: [], rejected: EMPTY_REJECTED, mutating: EMPTY_IDS };
  let changed = 0, saved = 0;
  let earlyEdits: Partial<InputDraftValue> | null = null;
  let writing: Promise<boolean> | null = null, loading: Promise<boolean> | null = null;
  const listeners = new Set<() => void>(), storedAttachments = new Map<string, import('@peer-agent/protocol').ProjectInputAttachment>(), active = new Map<string, Promise<ProjectAgentSubmitInputResult>>();
  const draftOrigins = new Map<string, InputDraftValue['quote']>();
  const optionOrigins = new Set<string>();
  const mutatingIds = new Set<string>();
  const publish = (patch: Partial<InputRecoveryView>) => { view = { ...view, ...patch }; for (const fn of listeners) fn(); };
  const isDraftEmpty = (draft: InputDraftValue) => !draft.text && !draft.quote && !draft.attachments.length
    && !draft.taskRefs?.length && !draft.resourceFeedback?.length;
  const hasComposedContent = (input: UnconfirmedProjectInput) => Boolean(
    input.attachments.length || input.quoteRefs.length || input.taskRefs?.length || input.resourceFeedback?.length,
  );
  const omitRejected = (ids: readonly string[]): Readonly<Record<string, string>> => {
    if (!ids.some(id => Object.prototype.hasOwnProperty.call(view.rejected, id))) return view.rejected;
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(view.rejected)) {
      if (!ids.includes(key)) next[key] = value;
    }
    return Object.keys(next).length ? next : EMPTY_REJECTED;
  };
  const markRejected = (inputId: string, code: string) => {
    if (view.rejected[inputId] === code) return;
    publish({ rejected: { ...view.rejected, [inputId]: code } });
  };
  const clearRejected = (ids: readonly string[]) => {
    const rejected = omitRejected(ids);
    if (rejected !== view.rejected) publish({ rejected });
  };
  const quoteForRestore = (input: UnconfirmedProjectInput): InputDraftValue['quote'] => {
    const savedQuote = draftOrigins.get(input.inputId);
    if (savedQuote !== undefined) return savedQuote;
    if (input.quoteRefs.length >= 2 && input.quoteRefs[0] && input.quoteRefs[1]) {
      return { messageId: input.quoteRefs[0], text: input.quoteRefs[1] };
    }
    return null;
  };
  const buildRestoredDraft = (input: UnconfirmedProjectInput, rejectionCode?: string): InputDraftValue => {
    const keepResourceFeedback = Boolean(
      input.resourceFeedback?.length && (!rejectionCode || !RESOURCE_REJECTION_CODES.has(rejectionCode)),
    );
    return {
      text: input.text,
      quote: quoteForRestore(input),
      attachments: input.attachments,
      ...(input.taskRefs?.length ? { taskRefs: input.taskRefs } : {}),
      ...(keepResourceFeedback ? { resourceFeedback: input.resourceFeedback } : {}),
    };
  };
  async function writeState(draftValue: InputDraftValue, pendingList: readonly UnconfirmedProjectInput[]): Promise<number | null> {
    const all = [...draftValue.attachments, ...pendingList.flatMap(item => item.attachments)];
    const uploads = [...new Map(all.filter(item => storedAttachments.get(item.id) !== item).map(item => [item.id, item])).values()];
    const { attachments, ...draft } = draftValue;
    const chunks = partitionUploadChunks(uploads);
    let revision = view.revision;
    const available = new Set(storedAttachments.keys());
    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        for (const item of chunk) available.add(item.id);
        const isFinal = i === chunks.length - 1;
        const result = await port.write({
          ...address,
          revision,
          draft: {
            ...draft,
            attachmentIds: isFinal
              ? attachments.map(item => item.id)
              : attachments.filter(item => available.has(item.id)).map(item => item.id),
          },
          pending: pendingList.map(({ attachments: pendingAttachments, ...input }) => ({
            ...input,
            attachmentIds: isFinal
              ? pendingAttachments.map(item => item.id)
              : pendingAttachments.filter(item => available.has(item.id)).map(item => item.id),
          })),
          uploads: chunk,
        });
        if (!result.ok) { publish({ error: result.code }); return null; }
        revision = result.revision;
        for (const item of chunk) storedAttachments.set(item.id, item);
        if (!isFinal) publish({ revision, error: null });
      }
      storedAttachments.clear();
      for (const item of all) storedAttachments.set(item.id, item);
      return revision;
    } catch { publish({ error: 'DRAFT_SAVE_FAILED' }); return null; }
  }
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
    while (writing) {
      const ok = await writing;
      if (!ok) return false;
      if (saved === changed) return true;
    }
    if (saved === changed) return true;
    writing = (async () => {
      while (saved !== changed) {
        const version = changed, state = view;
        const revision = await writeState(state.draft, state.pending);
        if (revision === null) return false;
        saved = version;
        publish({ revision, error: null });
      }
      return true;
    })().finally(() => { writing = null; });
    return writing;
  }
  function edit(patch: Partial<InputDraftValue>) {
    if (patch.resourceFeedback !== undefined) {
      const rows = normalizeResourceFeedbackList(patch.resourceFeedback);
      if (!rows || rows.some(row => row.recipient.workspaceId !== workspaceId)) { publish({ error: 'INVALID_RESOURCE_FEEDBACK' }); return; }
      patch = { ...patch, resourceFeedback: rows };
    }
    if (!view.ready) earlyEdits = { ...earlyEdits, ...patch };
    changed++; publish({ draft: { ...view.draft, ...patch } });
    if (view.ready) void flush();
  }
  function acknowledge(ids: readonly string[]) {
    for (const id of ids) { draftOrigins.delete(id); optionOrigins.delete(id); }
    const rejected = omitRejected(ids);
    const pending = view.pending.filter(item => !ids.includes(item.inputId));
    if (pending.length === view.pending.length) {
      if (rejected !== view.rejected) publish({ rejected });
      return;
    }
    const received = [...view.received, ...view.pending.filter(item => ids.includes(item.inputId))];
    changed++; publish({ pending, received, ...(rejected !== view.rejected ? { rejected } : {}) }); void flush();
  }
  function dismiss(ids: readonly string[]) {
    for (const id of ids) { draftOrigins.delete(id); optionOrigins.delete(id); }
    const rejected = omitRejected(ids);
    const pending = view.pending.filter(item => !ids.includes(item.inputId));
    if (pending.length === view.pending.length) {
      if (rejected !== view.rejected) publish({ rejected });
      return;
    }
    changed++; publish({ pending, ...(rejected !== view.rejected ? { rejected } : {}) }); void flush();
  }
  function recoverClosedDraft(input: UnconfirmedProjectInput, originalQuote: InputDraftValue['quote']) {
    if (!view.pending.some(item => item.inputId === input.inputId)) return;
    const rejected = omitRejected([input.inputId]);
    if (isDraftEmpty(view.draft)) {
      const pending = view.pending.filter(item => item.inputId !== input.inputId);
      const restored: InputDraftValue = {
        text: input.text,
        quote: originalQuote,
        attachments: input.attachments,
        ...(input.taskRefs?.length ? { taskRefs: input.taskRefs } : {}),
        ...(input.resourceFeedback?.length ? { resourceFeedback: input.resourceFeedback } : {}),
      };
      changed++; publish({ pending, draft: restored, ...(rejected !== view.rejected ? { rejected } : {}) }); void flush();
      return;
    }
    const pending = view.pending.map(item => {
      if (item.inputId !== input.inputId || !item.answerTo) return item;
      const { answerTo: _closed, ...plain } = item;
      return plain;
    });
    changed++; publish({ pending, ...(rejected !== view.rejected ? { rejected } : {}) }); void flush();
  }
  async function persistPendingMutation(
    inputId: string,
    mode: 'discard' | 'restore',
    options?: { readonly replaceDraft?: boolean },
  ): Promise<ProjectInputMutationResult> {
    if (!view.ready && !await load()) return { ok: false, code: view.error || 'DRAFT_UNAVAILABLE' };
    if (active.has(inputId)) return { ok: false, code: 'INPUT_SENDING' };
    if (mutatingIds.has(inputId)) return { ok: false, code: 'INPUT_BUSY' };
    if (!view.pending.some(item => item.inputId === inputId)) return { ok: false, code: 'INPUT_NOT_PENDING' };
    mutatingIds.add(inputId);
    publish({ mutating: [...mutatingIds] });
    try {
      while (writing || saved !== changed) {
        const ok = writing ? await writing : await flush();
        if (!ok) return { ok: false, code: view.error || 'DRAFT_SAVE_FAILED' };
      }
      if (active.has(inputId)) return { ok: false, code: 'INPUT_SENDING' };
      const target = view.pending.find(item => item.inputId === inputId);
      if (!target) return { ok: false, code: 'INPUT_NOT_PENDING' };
      if (mode === 'restore' && !options?.replaceDraft && !isDraftEmpty(view.draft)) {
        return { ok: false, code: 'DRAFT_NOT_EMPTY' };
      }
      const baseVersion = changed;
      const nextPendingForDisk = view.pending.filter(item => item.inputId !== inputId);
      const nextDraftForDisk = mode === 'restore' ? buildRestoredDraft(target, view.rejected[inputId]) : view.draft;
      let writtenRevision: number | null = null;
      writing = (async () => {
        writtenRevision = await writeState(nextDraftForDisk, nextPendingForDisk);
        return writtenRevision !== null;
      })().finally(() => { writing = null; });
      const ok = await writing;
      if (!ok || writtenRevision === null) return { ok: false, code: view.error || 'DRAFT_SAVE_FAILED' };
      if (mode === 'restore' && changed !== baseVersion) {
        publish({ revision: writtenRevision, error: null });
        void flush();
        return { ok: false, code: 'DRAFT_NOT_EMPTY' };
      }
      draftOrigins.delete(inputId);
      optionOrigins.delete(inputId);
      const rejected = omitRejected([inputId]);
      const nextPending = view.pending.filter(item => item.inputId !== inputId);
      if (changed === baseVersion) saved = baseVersion;
      publish({
        revision: writtenRevision,
        error: null,
        pending: nextPending,
        ...(mode === 'restore' ? { draft: nextDraftForDisk } : {}),
        ...(rejected !== view.rejected ? { rejected } : {}),
      });
      if (saved !== changed) void flush();
      return { ok: true };
    } finally {
      mutatingIds.delete(inputId);
      publish({ mutating: mutatingIds.size ? [...mutatingIds] : EMPTY_IDS });
    }
  }
  function dispatch(input: UnconfirmedProjectInput): Promise<ProjectAgentSubmitInputResult> {
    if (mutatingIds.has(input.inputId)) return Promise.resolve({ ok: false, code: 'INPUT_BUSY' });
    const running = active.get(input.inputId); if (running) return running;
    const job = (async () => {
      publish({ sending: [...view.sending, input.inputId] });
      try {
        if (!await flush()) return { ok: false, code: view.error || 'DRAFT_SAVE_FAILED' };
        // This deadline ends the presentation wait, never the host operation. A late
        // factual receipt still reconciles the original envelope without resending.
        const submitted = port.submit({ ...address, ...input }).then(result => {
          if (projectInputWasReceived(result, workspaceId, input.inputId)) { acknowledge([input.inputId]); return result; }
          if (isDefiniteProjectInputRejection(result, workspaceId, input.inputId)) {
            const code = result.code!;
            if (!view.pending.some(item => item.inputId === input.inputId)) return { ok: false, code };
            if (code === 'QUESTION_CLOSED') {
              if (optionOrigins.has(input.inputId) && !hasComposedContent(input)) {
                dismiss([input.inputId]);
              } else if (draftOrigins.has(input.inputId)) {
                const originalQuote = draftOrigins.get(input.inputId) ?? null;
                draftOrigins.delete(input.inputId);
                recoverClosedDraft(input, originalQuote);
              } else {
                markRejected(input.inputId, code);
              }
            } else {
              markRejected(input.inputId, code);
            }
            return { ok: false, code };
          }
          clearRejected([input.inputId]);
          return { ok: false, code: result.code || 'INPUT_OUTCOME_UNKNOWN' };
        }).catch(() => {
          clearRejected([input.inputId]);
          return { ok: false, code: 'INPUT_OUTCOME_UNKNOWN' };
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([submitted, new Promise<ProjectAgentSubmitInputResult>(resolve => {
            timer = setTimeout(() => resolve({ ok: false, code: 'INPUT_OUTCOME_UNKNOWN' }), receiptTimeoutMs);
          })]);
        } finally { clearTimeout(timer); }
      } catch { return { ok: false, code: 'INPUT_OUTCOME_UNKNOWN' }; }
      finally {
        active.delete(input.inputId);
        const sending = view.sending.filter(id => id !== input.inputId);
        publish({ sending: sending.length ? sending : EMPTY_IDS });
      }
    })();
    active.set(input.inputId, job); return job;
  }
  async function send(options: { text?: string; quoteRefs?: readonly string[]; taskRefs?: readonly import('@peer-agent/protocol').InputDraftTaskRef[]; answerTo?: string; useDraft?: boolean } = {}): Promise<ProjectAgentSubmitInputResult> {
    if (!view.ready && !await load()) return { ok: false, code: view.error || 'DRAFT_UNAVAILABLE' };
    const useDraft = options.useDraft !== false, draft = view.draft;
    const text = (options.text ?? draft.text).trim(), attachments = useDraft ? draft.attachments : [];
    const taskRefs = options.taskRefs ?? (useDraft ? (draft.taskRefs ?? []) : []);
    if (useDraft && options.text !== undefined && text !== draft.text.trim()) return { ok: false, code: 'INPUT_CHANGED' };
    const resourceFeedback = useDraft ? normalizeResourceFeedbackList(draft.resourceFeedback) : [];
    if (!resourceFeedback) return { ok: false, code: 'INVALID_RESOURCE_FEEDBACK' };
    if (!text && !attachments.length && !taskRefs.length && !resourceFeedback.some(row => row.resource.kind === 'interactive')) return { ok: false, code: 'INVALID_INPUT' };
    if (!useDraft && options.answerTo) {
      if (view.received.some(item => item.answerTo === options.answerTo)) return { ok: false, code: 'QUESTION_CLOSED' };
      const existing = view.pending.find(item => item.answerTo === options.answerTo);
      if (existing) {
        if (view.rejected[existing.inputId] === 'QUESTION_CLOSED') return { ok: false, code: 'QUESTION_CLOSED' };
        if (!view.rejected[existing.inputId]) return existing.text === text ? dispatch(existing) : { ok: false, code: 'INPUT_PENDING_ANSWER' };
      }
    }
    if (view.pending.length >= 32) return { ok: false, code: 'DRAFT_LIMIT' };
    if (resourceFeedback.some(item => item.recipient.workspaceId !== workspaceId)) return { ok: false, code: 'RESOURCE_FEEDBACK_RECIPIENT_CHANGED' };
    try { encodeResourceFeedbackTransport(resourceFeedback, attachments); }
    catch (error) { return { ok: false, code: (error as { code?: string }).code ?? 'INVALID_RESOURCE_FEEDBACK' }; }
    const input = { inputId: createId(), text, attachments, ...(resourceFeedback.length ? { resourceFeedback } : {}), ...(taskRefs.length ? { taskRefs } : {}), createdAt: now(), quoteRefs: options.quoteRefs ?? [],
      ...(options.answerTo ? { answerTo: options.answerTo } : {}) };
    if (useDraft) draftOrigins.set(input.inputId, draft.quote);
    else if (options.answerTo) optionOrigins.add(input.inputId);
    changed++; publish({ pending: [...view.pending, input], ...(useDraft ? { draft: emptyInputDraft() } : {}) });
    return dispatch(input);
  }
  return {
    getSnapshot: () => view,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    load, edit, flush, acknowledge, send,
    discard: (inputId: string) => persistPendingMutation(inputId, 'discard'),
    restoreToDraft: (inputId: string, options?: { readonly replaceDraft?: boolean }) => persistPendingMutation(inputId, 'restore', options),
    observeReceived(ids: readonly string[], answered?: readonly { readonly answerTo: string; readonly text: string }[]) {
      const isDuplicateCommittedReplyAnswer = (item: UnconfirmedProjectInput) => Boolean(
        answered?.length
        && !active.has(item.inputId)
        && item.answerTo?.startsWith('card:question:reply:')
        && !item.attachments.length
        && !item.taskRefs?.length
        && !item.resourceFeedback?.length
        && !item.quoteRefs.length
        && answered.some(entry => entry.answerTo === item.answerTo && entry.text.trim() === item.text.trim()),
      );
      const dropped: string[] = [];
      const pending = view.pending.filter(item => {
        const drop = ids.includes(item.inputId) || isDuplicateCommittedReplyAnswer(item);
        if (drop) { draftOrigins.delete(item.inputId); optionOrigins.delete(item.inputId); dropped.push(item.inputId); }
        return !drop;
      });
      const rejected = dropped.length ? omitRejected(dropped) : view.rejected;
      const received = view.received.filter(item => !ids.includes(item.inputId));
      if (pending.length !== view.pending.length) { changed++; publish({ pending, received, ...(rejected !== view.rejected ? { rejected } : {}) }); void flush(); }
      else if (received.length !== view.received.length) publish({ received });
    },
    retry(inputId: string) {
      if (mutatingIds.has(inputId)) return Promise.resolve({ ok: false, code: 'INPUT_BUSY' });
      const input = view.pending.find(item => item.inputId === inputId);
      return input ? dispatch(input) : Promise.resolve({ ok: false, code: 'INPUT_NOT_PENDING' });
    },
  };
}
export type ProjectInputRecovery = ReturnType<typeof createProjectInputRecovery>;
