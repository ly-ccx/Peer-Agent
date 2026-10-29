import {
  normalizeResourceTextDraft, normalizeResourceEditHandle, normalizeResourceEditWriter, validResourceEditText,
  type ResourceEditsApi, type ResourceEditView, type ResourceEditSource, type ResourceEditWriter, type ResourceEditNotice,
} from '@peer-agent/protocol';
import { feedbackDigest } from '../feedback/resourceSelection.ts';
export interface ResourceEditCursor { readonly start: number; readonly end: number; readonly top: number; readonly left: number }
export interface ResourceEditSessionState {
  readonly baseline: Pick<ResourceEditView['draft'], 'target' | 'baseText'> | null;
  readonly view: ResourceEditView | null; readonly writer: ResourceEditWriter | null;
  readonly text: string; readonly savedText: string; readonly dirty: boolean;
  readonly loading: boolean; readonly saving: boolean; readonly composing: boolean;
  readonly error: string | null; readonly remoteChanged: boolean; readonly reviewRequired: boolean;
  readonly cursor: ResourceEditCursor;
  readonly reading: Readonly<Partial<Record<'preview' | 'compare', { readonly top: number; readonly left: number }>>>;
}
interface SessionOptions {
  readonly workspaceId: string; readonly draftId: string; readonly api: ResourceEditsApi; readonly source?: ResourceEditSource;
  readonly expectedPath?: string; readonly initial?: ResourceEditView;
  readonly hashText?: (text: string) => Promise<string>; readonly createId?: () => string;
  readonly schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const leaseError = (code: string) => /STALE_WRITER|WRITER_BUSY|VIEW_EXPIRED|SOURCE_CHANGED|RECIPIENT_CHANGED/.test(code);
/** A recoverable local text buffer. No file-submit, task, permission or model port is used. */
export function createResourceEditSession(options: SessionOptions) {
  const { api, workspaceId, draftId } = options;
  const hashText = options.hashText ?? feedbackDigest, schedule = options.schedule ?? setTimeout, cancel = options.cancel ?? clearTimeout;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const listeners = new Set<() => void>();
  let state: ResourceEditSessionState = { baseline: null, view: null, writer: null, text: '', savedText: '', dirty: false, loading: false, saving: false, composing: false,
    error: null, remoteChanged: false, reviewRequired: false, cursor: { start: 0, end: 0, top: 0, left: 0 }, reading: {} };
  let timer: ReturnType<typeof setTimeout> | null = null, generation = 0, editSequence = 0, opening: Promise<boolean> | null = null;
  let requestId: string | null = null, saving: Promise<boolean> | null = null, claiming: Promise<boolean> | null = null;
  function publish(patch: Partial<ResourceEditSessionState>) {
    const next = { ...state, ...patch }; state = { ...next, dirty: next.text !== next.savedText };
    for (const listener of listeners) listener();
  }
  function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
  function queueSave() {
    clearTimer();
    if (!state.dirty || !state.writer || state.composing || state.reviewRequired || !validResourceEditText(state.text)) return;
    timer = schedule(() => { timer = null; void flush(); }, 350);
  }
  function checked(raw: ResourceEditView): ResourceEditView | null {
    const draft = normalizeResourceTextDraft(raw?.draft), handle = normalizeResourceEditHandle(raw?.handle);
    if (!draft || !handle || handle.draftId !== draftId || draft.id !== draftId || draft.target.recipient.workspaceId !== workspaceId
      || options.expectedPath !== undefined && draft.target.reference.path !== options.expectedPath
      || state.view && (!equal(state.view.draft.target, draft.target) || !equal(state.view.handle, handle))) return null;
    return { draft, handle };
  }
  function adopt(raw: ResourceEditView, keep: boolean) {
    const value = checked(raw); if (!value) { const handle = normalizeResourceEditHandle(raw?.handle); if (handle) void api.close(handle).catch(() => {}); publish({ error: 'RESOURCE_EDIT_SOURCE_CHANGED', loading: false }); return false; }
    const conflict = keep && (state.reviewRequired || state.savedText !== value.draft.text);
    publish({ view: value, baseline: { target: value.draft.target, baseText: value.draft.baseText }, savedText: value.draft.text, text: keep ? state.text : value.draft.text, loading: false,
      remoteChanged: false, reviewRequired: conflict, error: conflict ? 'RESOURCE_EDIT_LOCAL_CONFLICT' : null });
    return true;
  }
  if (options.initial) adopt(options.initial, false);
  async function connect() {
    if (opening) return opening;
    if (state.view) return true;
    const ticket = ++generation, sequence = editSequence, id = createId(); requestId = id;
    publish({ loading: true, error: null });
    opening = Promise.resolve().then(async () => {
      try {
        const result = await api.resume({ requestId: id, workspaceId, draftId, ...(options.source?.kind === 'native' ? { source: options.source } : {}) });
        if (generation !== ticket) { if (result.ok) void api.close(result.handle).catch(() => {}); return false; }
        if (!result.ok) { publish({ loading: false, error: result.code }); return false; }
        return adopt(result, state.dirty || editSequence !== sequence);
      } catch { if (generation === ticket) publish({ loading: false, error: 'RESOURCE_EDIT_SOURCE_UNAVAILABLE' }); return false; }
      finally { if (requestId === id) requestId = null; opening = null; }
    });
    return opening;
  }
  async function claim(takeover = false) {
    if (claiming) return claiming;
    claiming = Promise.resolve().then(async () => {
      if (saving) await saving;
      if (!state.view && !await connect()) return false;
      const view = state.view!, ticket = generation, sequence = editSequence, keep = state.dirty;
      publish({ loading: true, error: null });
      try {
        const result = await api.acquire({ handle: view.handle, takeover });
        if (generation !== ticket) { if (result.ok) void api.close(result.handle).catch(() => {}); return false; }
        if (!result.ok) { publish({ loading: false, writer: null, error: result.code }); return false; }
        const writer = normalizeResourceEditWriter(result.writer);
        if (!writer || writer.viewId !== view.handle.viewId || writer.windowId !== view.handle.windowId || writer.generation !== view.handle.generation) { publish({ loading: false, writer: null, error: 'RESOURCE_EDIT_SOURCE_CHANGED' }); return false; }
        if (!adopt(result, keep || editSequence !== sequence)) return false;
        publish({ writer });
        // Taking ownership is not consent to overwrite another saved draft with a buffered conflict.
        if (!state.reviewRequired) queueSave(); return true;
      } catch { if (generation === ticket) publish({ loading: false, error: 'RESOURCE_EDIT_SOURCE_UNAVAILABLE' }); return false; }
      finally { claiming = null; }
    });
    return claiming;
  }
  function acknowledge(view: ResourceEditView, text: string, revision: number, updatedAt: string) {
    publish({ view: { handle: view.handle, draft: { ...view.draft, text, revision, updatedAt } }, savedText: text, error: null });
  }
  async function reconcile(view: ResourceEditView, sent: string, before: string, ticket: number, code: string) {
    try {
      const result = await api.read(view.handle);
      if (generation !== ticket) return false;
      const current = result.ok ? checked(result) : null;
      if (current && current.draft.text === sent && current.draft.revision >= view.draft.revision) {
        acknowledge(current, sent, current.draft.revision, current.draft.updatedAt); return true;
      }
      if (current && current.draft.text === before && current.draft.revision === view.draft.revision) { publish({ error: code }); return false; }
      if (current) {
        publish({ view: current, savedText: current.draft.text, writer: null, remoteChanged: true, reviewRequired: true, error: 'RESOURCE_EDIT_LOCAL_CONFLICT' });
      } else publish({ writer: null, error: result.ok ? 'RESOURCE_EDIT_SOURCE_CHANGED' : result.code });
    } catch { if (generation === ticket) publish({ error: code }); }
    return false;
  }
  function flush(): Promise<boolean> {
    clearTimer(); if (saving) return saving;
    if (!state.dirty) return Promise.resolve(!state.composing);
    if (state.composing) { publish({ error: 'RESOURCE_EDIT_COMPOSITION_ACTIVE' }); return Promise.resolve(false); }
    if (state.reviewRequired) { publish({ error: 'RESOURCE_EDIT_LOCAL_CONFLICT' }); return Promise.resolve(false); }
    if (!state.writer || !state.view) { publish({ error: 'RESOURCE_EDIT_STALE_WRITER' }); return Promise.resolve(false); }
    if (!validResourceEditText(state.text)) { publish({ error: 'RESOURCE_EDIT_TEXT_LIMIT' }); return Promise.resolve(false); }
    const ticket = generation;
    saving = Promise.resolve().then(async () => {
      publish({ saving: true });
      try {
        for (let attempt = 0; attempt < 8 && state.dirty; attempt++) {
          if (state.composing || state.reviewRequired || !state.writer || !state.view || !validResourceEditText(state.text)) return false;
          const view = state.view, text = state.text, before = state.savedText, writer = state.writer;
          let result: Awaited<ReturnType<ResourceEditsApi['save']>>;
          try { result = await api.save({ handle: view.handle, writer, revision: view.draft.revision, text }); }
          catch { result = { ok: false, code: 'RESOURCE_EDIT_SAVE_UNCONFIRMED' }; }
          if (generation !== ticket) return false;
          if (result.ok) {
            const receipt = result.saved;
            const valid = receipt.draftId === draftId && receipt.revision === view.draft.revision + 1 && Number.isFinite(Date.parse(receipt.updatedAt))
              && receipt.textVersion === await hashText(text);
            if (generation !== ticket) return false;
            if (valid) acknowledge(view, text, receipt.revision, receipt.updatedAt);
            else if (!await reconcile(view, text, before, ticket, 'RESOURCE_EDIT_SAVE_UNCONFIRMED')) return false;
          } else {
            if (leaseError(result.code)) { publish({ writer: null, error: result.code }); return false; }
            if (!await reconcile(view, text, before, ticket, result.code)) return false;
          }
        }
        if (state.dirty) queueSave(); return !state.dirty && !state.composing;
      } catch { if (generation === ticket) publish({ error: 'RESOURCE_EDIT_SAVE_UNCONFIRMED' }); return false; }
      finally { saving = null; if (generation === ticket) publish({ saving: false }); }
    });
    return saving;
  }
  async function close(stillUnused: () => boolean = () => true) {
    if (!await flush() || !stillUnused()) return false;
    clearTimer(); const handle = state.view?.handle; generation++;
    if (requestId) { void api.cancelOpen(requestId).catch(() => {}); requestId = null; }
    publish({ view: null, writer: null, loading: false, saving: false });
    if (handle) try { const result = await api.close(handle); if (!result.ok && result.code !== 'RESOURCE_EDIT_VIEW_EXPIRED') { publish({ error: result.code }); return false; } }
      catch { publish({ error: 'RESOURCE_EDIT_SOURCE_UNAVAILABLE' }); return false; }
    return true;
  }
  return {
    workspaceId, draftId, expectedPath: options.expectedPath, source: options.source,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, snapshot: () => state,
    connect, claim, flush, close,
    edit(text: string) { editSequence++; publish({ text, error: validResourceEditText(text) ? null : 'RESOURCE_EDIT_TEXT_LIMIT' }); queueSave(); },
    setComposing(active: boolean) { clearTimer(); publish({ composing: active, ...(active ? {} : { error: state.error === 'RESOURCE_EDIT_COMPOSITION_ACTIVE' ? null : state.error }) }); if (!active) queueSave(); },
    remember(cursor: ResourceEditCursor) { state = { ...state, cursor }; },
    rememberReading(mode: 'preview' | 'compare', point: { readonly top: number; readonly left: number }) {
      if (![point.top, point.left].every(value => Number.isFinite(value) && value >= 0 && value <= 10_000_000)) return;
      state = { ...state, reading: { ...state.reading, [mode]: point } };
    },
    receive(notice: ResourceEditNotice) {
      if (notice.workspaceId !== workspaceId || notice.draftId && notice.draftId !== draftId) return;
      if (notice.kind === 'writer' && notice.writerViewId !== state.view?.handle.viewId) { clearTimer(); publish({ writer: null, error: state.dirty ? 'RESOURCE_EDIT_STALE_WRITER' : null }); }
      if (notice.kind === 'saved' && notice.revision !== undefined && state.view && notice.revision > state.view.draft.revision && !state.saving) publish({ remoteChanged: true });
      if (notice.kind === 'discarded') { generation++; clearTimer(); publish({ view: null, writer: null, loading: false, saving: false, error: 'RESOURCE_EDIT_DRAFT_MISSING' }); }
    },
    async readSaved() {
      if (saving) await saving;
      if (!state.view && !await connect()) return false;
      const ticket = generation, sequence = editSequence, handle = state.view!.handle;
      try { const result = await api.read(handle); if (generation !== ticket) return false;
        if (!result.ok) { publish({ error: result.code }); return false; }
        return adopt(result, state.dirty || sequence !== editSequence);
      } catch { if (generation === ticket) publish({ error: 'RESOURCE_EDIT_SOURCE_UNAVAILABLE' }); return false; }
    },
    async confirmBufferedSave() { publish({ reviewRequired: false }); return flush(); },
    useSavedText() { editSequence++; publish({ text: state.savedText, reviewRequired: false, remoteChanged: false, error: null }); },
    async discard() {
      if (saving) await saving;
      const view = state.view, writer = state.writer, sequence = editSequence; if (!view || !writer || state.composing) return false;
      try {
        const result = await api.discard({ handle: view.handle, writer, revision: view.draft.revision });
        if (!result.ok) { publish({ error: result.code }); return false; }
        generation++; clearTimer();
        if (sequence !== editSequence) publish({ view: null, writer: null, savedText: '', saving: false, loading: false, error: 'RESOURCE_EDIT_DRAFT_MISSING' });
        else publish({ view: null, writer: null, text: '', savedText: '', saving: false, loading: false, error: null });
        return true;
      } catch { publish({ error: 'RESOURCE_EDIT_SOURCE_UNAVAILABLE' }); return false; }
    },
    cancelOpening() { if (requestId) { generation++; void api.cancelOpen(requestId).catch(() => {}); requestId = null; publish({ loading: false }); } },
  };
}
export type ResourceEditSession = ReturnType<typeof createResourceEditSession>;
