import type { InteractiveFollowup, InteractiveOpenView, InteractiveResultsApi, InteractiveStateSnapshot, InteractiveStateValue,
  InteractiveStateValues, InteractiveWriter } from '@peer-agent/protocol';
import { canonicalJSON } from '@peer-agent/interactive-content/values';
import { validateState } from '@peer-agent/interactive-content/state';
import type { InteractiveEvaluator } from '@peer-agent/interactive-content';

type Candidate = { readonly edit: number; readonly values: InteractiveStateValues; readonly inputDrafts: Readonly<Record<string, string>>; readonly requestId: string };
type PendingSave = { readonly candidate: Candidate; readonly writer: InteractiveWriter; readonly expectedRevision: number };
type FollowupCandidate = Candidate & { readonly fields: readonly string[]; readonly followupId: string; saved?: InteractiveStateSnapshot };
export interface InteractiveSessionSnapshot {
  readonly values: InteractiveStateValues;
  readonly inputDrafts: Readonly<Record<string, string>>;
  readonly sdkValues: InteractiveStateValues;
  readonly confirmed: InteractiveStateSnapshot;
  readonly writer: InteractiveWriter | null;
  readonly phase: 'readonly' | 'ready' | 'saving' | 'save_failed' | 'writer_lost' | 'closing' | 'closed';
  readonly dirty: boolean;
  readonly composing: boolean;
  readonly calculationError: string | null;
  readonly saveError: string | null;
  readonly preparation: 'idle' | 'saving' | 'freezing' | 'frozen' | 'failed';
  readonly preparationError: string | null;
  readonly frozen: InteractiveFollowup | null;
  readonly draftPreparation: 'idle' | 'preparing' | 'prepared' | 'failed';
  readonly draftError: string | null;
}
const clone = <T,>(value: T): T => structuredClone(value);
const equal = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const numeric = (raw: string) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()) && Number.isFinite(Number(raw));
const code = (error: unknown) => typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'interactive_storage_unavailable';
const lost = (value: string) => ['interactive_writer_stale', 'interactive_state_conflict', 'interactive_view_stale'].includes(value);

/** Local drafts and request ordering. Only confirmed host replies advance the save checkpoint. */
export function createInteractiveSession({ api, opened, evaluator, createId = () => crypto.randomUUID() }: {
  readonly api: InteractiveResultsApi; readonly opened: InteractiveOpenView; readonly evaluator: InteractiveEvaluator; readonly createId?: () => string;
}) {
  const content = opened.result.content, handle = clone(opened.handle), listeners = new Set<() => void>(), composing = new Set<string>();
  let edit = 0, savedEdit = 0, pending: PendingSave | null = null, tail: Promise<unknown> = Promise.resolve();
  let candidate: FollowupCandidate | null = null;
  const initial = validateState(opened.state.values, content.stateSchema, opened.state.inputDrafts);
  let state: InteractiveSessionSnapshot = { ...initial, sdkValues: clone(content.initialValues), confirmed: clone(opened.state), writer: null,
    phase: 'readonly', dirty: false, composing: false, calculationError: null, saveError: null, preparation: 'idle', preparationError: null, frozen: null,
    draftPreparation: 'idle', draftError: null };
  function changed(patch: Partial<InteractiveSessionSnapshot> = {}) { state = { ...state, ...patch }; for (const listener of listeners) listener(); }
  function calculate() {
    const incomplete = composing.size > 0 || Object.entries(state.inputDrafts).some(([key, raw]) => content.stateSchema[key]?.type === 'number'
      ? !numeric(raw) || Number(raw) !== state.values[key] : raw !== state.values[key]);
    try {
      if (incomplete) throw { code: 'input_incomplete' };
      evaluator.evaluate(state.values);
      changed({ sdkValues: clone(state.values), calculationError: null });
    } catch (error) { changed({ calculationError: code(error) }); }
  }
  calculate();
  const editable = () => !!state.writer && !['closing', 'closed', 'writer_lost'].includes(state.phase);
  const capture = (): Candidate => ({ edit, values: clone(state.values), inputDrafts: clone(state.inputDrafts), requestId: createId() });
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const work = tail.then(operation, operation); tail = work.catch(() => {}); return work;
  }
  function acceptHostSnapshot(snapshot: InteractiveStateSnapshot, saving: PendingSave) {
    if (!equal(snapshot.result, opened.result.reference) || snapshot.specHash !== content.specHash || snapshot.stateSchemaHash !== content.stateSchemaHash
      || snapshot.stateRevision !== saving.expectedRevision + 1 || snapshot.requestId !== saving.candidate.requestId
      || !equal(snapshot.values, saving.candidate.values) || !equal(snapshot.inputDrafts, saving.candidate.inputDrafts)) throw { code: 'interactive_state_receipt_invalid' };
    validateState(snapshot.values, content.stateSchema, snapshot.inputDrafts);
    savedEdit = saving.candidate.edit;
    changed({ confirmed: clone(snapshot), dirty: savedEdit !== edit, saveError: null });
  }
  async function saveCandidate(selected: Candidate): Promise<InteractiveStateSnapshot | null> {
    if (!editable()) { changed({ saveError: state.phase === 'writer_lost' ? 'interactive_writer_stale' : 'interactive_writer_required' }); return null; }
    if (pending) {
      const saving = pending;
      changed({ phase: 'saving', saveError: null });
      try {
        const reply = await api.save({ handle, writer: saving.writer, expectedRevision: saving.expectedRevision, requestId: saving.candidate.requestId,
          values: saving.candidate.values, inputDrafts: saving.candidate.inputDrafts });
        if (!reply.ok) throw { code: reply.code };
        acceptHostSnapshot(reply.state, saving); pending = null; changed({ phase: 'ready' });
      } catch (error) {
        const failure = code(error); changed({ phase: lost(failure) ? 'writer_lost' : 'save_failed', saveError: failure }); return null;
      }
    }
    if (selected.edit === savedEdit && equal(selected.values, state.confirmed.values) && equal(selected.inputDrafts, state.confirmed.inputDrafts)) return state.confirmed;
    pending = { candidate: selected, writer: state.writer!, expectedRevision: state.confirmed.stateRevision };
    return saveCandidate(selected);
  }
  function setValues(values: InteractiveStateValues, inputDrafts: Readonly<Record<string, string>>) {
    const normalized = validateState(values, content.stateSchema, inputDrafts);
    edit++;
    changed({ ...normalized, dirty: edit !== savedEdit, composing: composing.size > 0 }); calculate();
  }
  function flush() {
    if (composing.size) return Promise.resolve(false);
    if (!state.dirty && !pending) return Promise.resolve(true);
    const selected = capture(); return enqueue(async () => !!await saveCandidate(selected));
  }
  async function freezeSelection() {
    if (!candidate || !editable()) return null;
    const selected = candidate;
    changed({ preparation: 'saving', preparationError: null });
    const saved = selected.saved ?? await saveCandidate(selected);
    if (!saved) { changed({ preparation: 'failed', preparationError: state.saveError }); return null; }
    selected.saved = saved;
    changed({ preparation: 'freezing' });
    try {
      const reply = await api.prepareFollowup({ handle, stateRevision: saved.stateRevision, stateDigest: saved.stateDigest,
        fields: selected.fields, requestId: selected.followupId });
      if (!reply.ok) throw { code: reply.code };
      if (reply.followup.followupId !== selected.followupId || !equal(reply.followup.result, opened.result.reference)
        || !equal(reply.followup.recipient, opened.result.reference.owner) || reply.followup.specHash !== content.specHash
        || reply.followup.stateRevision !== saved.stateRevision || reply.followup.stateDigest !== saved.stateDigest
        || !equal(reply.followup.values, Object.fromEntries(selected.fields.map(key => [key, selected.values[key]])))) throw { code: 'interactive_followup_receipt_invalid' };
      changed({ preparation: 'frozen', preparationError: null, frozen: clone(reply.followup) }); return reply.followup;
    } catch (error) { changed({ preparation: 'failed', preparationError: code(error) }); return null; }
  }
  function prepareSelection(fields: readonly string[]) {
    if (['saving', 'freezing'].includes(state.preparation)) return Promise.resolve(null);
    if (!editable() || composing.size || !fields.length || fields.length > 64 || new Set(fields).size !== fields.length || fields.some(key => !Object.hasOwn(content.stateSchema, key)
      || state.inputDrafts[key] !== undefined && (content.stateSchema[key].type === 'number'
        ? !numeric(state.inputDrafts[key]) || Number(state.inputDrafts[key]) !== state.values[key] : state.inputDrafts[key] !== state.values[key]))) {
      candidate = null; changed({ frozen: null, preparation: 'failed', preparationError: 'followup_input_incomplete' }); return Promise.resolve(null);
    }
    candidate = { ...capture(), fields: [...fields], followupId: createId() };
    changed({ frozen: null, preparation: 'saving', preparationError: null }); return enqueue(freezeSelection);
  }
  function retrySelection() {
    if (['saving', 'freezing'].includes(state.preparation)) return Promise.resolve(null);
    if (!candidate) { changed({ preparation: 'failed', preparationError: 'followup_input_incomplete' }); return Promise.resolve(null); }
    changed({ preparation: 'saving', preparationError: null }); return enqueue(freezeSelection);
  }
  async function prepareDraft(fields?: readonly string[]) {
    if (state.draftPreparation === 'preparing' || ['closing', 'closed'].includes(state.phase)) return false;
    if (!api.prepareDraft) { changed({ draftPreparation: 'failed', draftError: 'interactive_draft_unavailable' }); return false; }
    changed({ draftPreparation: 'preparing', draftError: null });
    const frozen = fields ? await prepareSelection(fields) : state.frozen ?? await retrySelection();
    if (!frozen) { changed({ draftPreparation: 'failed', draftError: state.preparationError ?? 'interactive_followup_unavailable' }); return false; }
    try {
      const reply = await api.prepareDraft({ handle, followupId: frozen.followupId });
      if (!reply.ok) throw { code: reply.code };
      if (reply.followupId !== frozen.followupId) throw { code: 'interactive_draft_receipt_invalid' };
      changed({ draftPreparation: 'prepared', draftError: null }); return true;
    } catch (error) { changed({ draftPreparation: 'failed', draftError: code(error) }); return false; }
  }
  return {
    handle, content,
    canPrepareDraft: () => typeof api.prepareDraft === 'function',
    prepareDraft,
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async acquire(takeover = false) {
      return enqueue(async () => {
        if (state.phase === 'closed' || state.phase === 'closing') return false;
        try {
          if (pending && editable() && !await saveCandidate(capture())) return false;
          // Explicit takeover retains local edits but starts against the actual current checkpoint.
          const fresh = await api.readState({ handle }); if (!fresh.ok) throw { code: fresh.code };
          if (!equal(fresh.state.result, opened.result.reference) || fresh.state.specHash !== content.specHash || fresh.state.stateSchemaHash !== content.stateSchemaHash) throw { code: 'interactive_state_receipt_invalid' };
          const normalized = validateState(fresh.state.values, content.stateSchema, fresh.state.inputDrafts);
          const reply = await api.acquire({ handle, expectedRevision: fresh.state.stateRevision, ...(takeover ? { takeover: true } : {}) });
          if (!reply.ok) throw { code: reply.code };
          pending = null;
          if (!state.dirty) changed(normalized);
          changed({ writer: clone(reply.writer), confirmed: clone(fresh.state), phase: 'ready', saveError: null }); calculate(); return true;
        } catch (error) { changed({ saveError: code(error), phase: state.writer ? 'writer_lost' : 'readonly' }); return false; }
      });
    },
    editText(key: string, raw: string, isComposing = false) {
      if (!editable() || !Object.hasOwn(content.stateSchema, key) || !['string', 'number'].includes(content.stateSchema[key].type)) return false;
      if (isComposing) composing.add(key); else composing.delete(key);
      const values = { ...state.values }, inputDrafts = { ...state.inputDrafts, [key]: raw };
      if (!isComposing && content.stateSchema[key].type === 'string') values[key] = raw;
      if (!isComposing && content.stateSchema[key].type === 'number' && numeric(raw)) {
        const number = Number(raw), rule = content.stateSchema[key];
        if (number >= (rule.min ?? -Infinity) && number <= (rule.max ?? Infinity)) values[key] = number;
      }
      try { setValues(values, inputDrafts); return true; } catch (error) { changed({ composing: composing.size > 0, calculationError: code(error) }); return false; }
    },
    editValue(key: string, value: InteractiveStateValue) {
      if (!editable() || !Object.hasOwn(content.stateSchema, key)) return false;
      const drafts = { ...state.inputDrafts }; delete drafts[key];
      try { setValues({ ...state.values, [key]: value }, drafts); return true; } catch (error) { changed({ calculationError: code(error) }); return false; }
    },
    applyAction(plan: unknown) {
      if (!editable() || composing.size) return false;
      try {
        const applied = evaluator.applyAction(plan, state.values), drafts = { ...state.inputDrafts };
        for (const key of applied.changedFields) delete drafts[key];
        setValues(applied.values, drafts); return true;
      }
      catch (error) { changed({ calculationError: code(error) }); return false; }
    },
    reset() {
      if (!editable() || composing.size) return false;
      setValues(clone(content.initialValues), {}); return true;
    },
    preserveInterruptedComposition() {
      // Explicit recovery after a control surface is lost. Preserve raw text as
      // a draft; it must not become an effective value or frozen condition.
      if (!composing.size) return;
      composing.clear(); changed({ composing: false }); calculate();
    },
    flush,
    prepareSelection,
    retrySelection,
    async close() {
      if (state.phase === 'closed') return true;
      if (state.dirty || pending) { if (!await flush()) return false; }
      return enqueue(async () => {
        if (state.dirty || pending || composing.size) return false;
        changed({ phase: 'closing', saveError: null });
        try { const reply = await api.release({ handle, ...(state.writer ? { writer: state.writer } : {}) }); if (!reply.ok) throw { code: reply.code };
          changed({ phase: 'closed', writer: null }); return true;
        } catch (error) { changed({ saveError: code(error) }); return false; }
      });
    },
  };
}
export type InteractiveSession = ReturnType<typeof createInteractiveSession>;
