import { normalizeInteractiveReference, normalizeInteractiveViewHandle, type InteractiveOpenView, type InteractiveResultReference,
  type InteractiveResultsApi, type InteractiveResultSummary } from '@peer-agent/protocol';
import { createInteractiveSession, type InteractiveSession } from './interactiveSession.ts';

export const interactiveSessionKey = (reference: InteractiveResultReference) => JSON.stringify([reference.owner.workspaceId, reference.owner.conversationId, reference.resultId, reference.contentVersion]);
export interface InteractiveEntry {
  readonly reference: InteractiveResultReference;
  readonly requestId: string;
  phase: 'opening' | 'ready' | 'failed';
  error: string | null;
  opened?: InteractiveOpenView;
  summary?: InteractiveResultSummary;
  session?: InteractiveSession;
  cancelled?: boolean;
  uses: number;
}
/** Domain entries outlive expensive mounted content; checkpoints still live in the host. */
export function createInteractiveSessionRegistry(api: InteractiveResultsApi) {
  const entries = new Map<string, InteractiveEntry>(), opening = new Map<string, Promise<InteractiveEntry>>(), listeners = new Set<() => void>();
  let version = 0;
  const changed = () => { version++; for (const listener of listeners) listener(); };
  function open(raw: InteractiveResultReference): Promise<InteractiveEntry> {
    const reference = normalizeInteractiveReference(raw);
    if (!reference) return Promise.reject(Error('interactive_reference_invalid'));
    const key = interactiveSessionKey(reference), pending = opening.get(key);
    if (pending) return pending;
    let entry = entries.get(key);
    if (entry?.session?.snapshot().phase === 'closed') { entries.delete(key); entry = undefined; }
    if (entry?.phase === 'ready' && entry.session?.snapshot().phase === 'closing') {
      const closing = entry;
      return closing.session!.close().then(ok => {
        if (!ok) return closing;
        if (entries.get(key) === closing) { entries.delete(key); changed(); }
        return open(reference);
      });
    }
    if (entry?.phase === 'ready') return Promise.resolve(entry);
    if (!entry) {
      if (entries.size >= 32) return Promise.reject(Error('interactive_view_limit'));
      entry = { reference, requestId: crypto.randomUUID(), phase: 'opening', error: null, uses: 0 }; entries.set(key, entry);
    } else { entry.phase = 'opening'; entry.error = null; }
    const current = entry;
    const promise: Promise<InteractiveEntry> = Promise.resolve().then(async (): Promise<InteractiveEntry> => {
      try {
        const reply = await api.open({ reference, requestId: current.requestId });
        if (current.cancelled) { if (reply.ok) void api.release({ handle: reply.handle }).catch(() => {}); return current; }
        if (!reply.ok) {
          if (reply.summary && interactiveSessionKey(reply.summary.reference) === key) current.summary = structuredClone(reply.summary);
          throw { code: reply.code };
        }
        if (!normalizeInteractiveViewHandle(reply.handle) || interactiveSessionKey(reply.result.reference) !== key || interactiveSessionKey(reply.state.result) !== key
          || reply.state.specHash !== reply.result.content.specHash || reply.state.stateSchemaHash !== reply.result.content.stateSchemaHash) {
          void api.release({ handle: reply.handle }).catch(() => {}); throw { code: 'interactive_state_receipt_invalid' };
        }
        current.opened = reply;
        current.summary = { reference, title: reply.result.content.title, textFallback: reply.result.content.textFallback,
          specHash: reply.result.content.specHash, libraryVersion: reply.result.content.libraryVersion, dataLevel: reply.result.dataLevel };
        try {
          const { prepareEvaluator } = await import('@peer-agent/interactive-content');
          const evaluator = await prepareEvaluator(reply.result.content);
          if (current.cancelled) { void api.release({ handle: reply.handle }).catch(() => {}); return current; }
          // The host omits its derived render cache. Rebuild it from the checked
          // evaluator for local recovery labels; it never becomes content truth.
          const presentation = { ...reply, result: { ...reply.result, content: { ...reply.result.content,
            tree: evaluator.evaluate(reply.result.content.initialValues).tree } } };
          current.session = createInteractiveSession({ api, opened: presentation, evaluator }); current.phase = 'ready';
        } catch (error) {
          await api.release({ handle: reply.handle }).catch(() => {}); throw error;
        }
      } catch (error) {
        current.phase = 'failed'; current.error = (error as { code?: string })?.code ?? 'interactive_source_unavailable';
      } finally {
        if (opening.get(key) === promise) opening.delete(key);
        if (!current.cancelled) changed();
      }
      return current;
    });
    opening.set(key, promise); changed(); return promise;
  }
  return {
    api, open,
    get: (reference: InteractiveResultReference) => entries.get(interactiveSessionKey(reference)),
    list: () => [...entries.values()],
    attach(reference: InteractiveResultReference) {
      const entry = entries.get(interactiveSessionKey(reference));
      if (!entry) return () => {};
      entry.uses++; changed(); let attached = true;
      return () => { if (attached) { attached = false; entry.uses--; changed(); } };
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => version,
    async recheckOwners() {
      await Promise.all([...entries.values()].flatMap(({ session }) => session ? [session.recheckOwner()] : []));
    },
    async flushAll() {
      if ([...entries.values()].some(entry => entry.phase === 'opening' && !entry.cancelled)) return false;
      return (await Promise.all([...entries.values()].flatMap(({ session }) => session ? [(async () => {
        const saved = await session.flush();
        if (!saved) await session.recheckOwner();
        return saved;
      })()] : []))).every(Boolean);
    },
    hasUnsafe: () => [...entries.values()].some(entry => !entry.cancelled && (entry.phase === 'opening' || entry.session && (() => {
      const state = entry.session.snapshot();
      return state.phase !== 'closed' && (state.ownerReplaced || state.dirty || state.composing || state.savePending || state.phase === 'saving');
    })())),
    async close(reference: InteractiveResultReference) {
      const key = interactiveSessionKey(reference), entry = entries.get(key); if (!entry) return true;
      if (entry.session && !await entry.session.close()) return false;
      if (!entry.session) {
        if (entry.phase === 'opening') { entry.cancelled = true; opening.delete(key); void api.cancelOpen?.({ requestId: entry.requestId }).catch(() => {}); }
        else if (entry.opened) await api.release({ handle: entry.opened.handle }).catch(() => {});
      }
      entries.delete(key); changed(); return true;
    },
  };
}
export type InteractiveSessionRegistry = ReturnType<typeof createInteractiveSessionRegistry>;
const registries = new WeakMap<InteractiveResultsApi, InteractiveSessionRegistry>();
export function interactiveSessionRegistry(api: InteractiveResultsApi | undefined = window.peerResource?.interactiveResults ?? window.peerAgent?.interactiveResults) {
  if (!api) return null;
  let registry = registries.get(api); if (!registry) { registry = createInteractiveSessionRegistry(api); registries.set(api, registry); }
  return registry;
}
