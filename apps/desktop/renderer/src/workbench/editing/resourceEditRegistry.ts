import { normalizeResourceEditHandle, normalizeResourceTextDraft, type ResourceEditSource, type ResourceEditsApi, type ResourceEditView } from '@peer-agent/protocol';
import { createResourceEditSession, type ResourceEditSession } from './resourceEditSession.ts';
import { createResourceSubmissionController, type ResourceSubmissionController } from './resourceSubmissionController.ts';
export function resourceEditKey(workspaceId: string, draftId: string) { return JSON.stringify([workspaceId, draftId]); }
export function createResourceEditRegistry(api: ResourceEditsApi) {
  const entries = new Map<string, { session: ResourceEditSession; submission?: ResourceSubmissionController; unsubscribeSubmission?: () => void; uses: number; at: number; unsubscribe: () => void }>(), opening = new Map<string, Promise<ResourceEditSession | null>>();
  const listeners = new Set<() => void>(); let version = 0, lastError: string | null = null;
  function changed() { version++; for (const listener of listeners) listener(); }
  function room() {
    if (entries.size < 32) return true;
    const disposable = [...entries].filter(([, entry]) => !entry.uses && !entry.session.snapshot().dirty && !entry.session.snapshot().composing && !entry.session.snapshot().view && !entry.submission?.snapshot().intent && !entry.submission?.snapshot().action)
      .sort((a, b) => a[1].at - b[1].at)[0];
    if (!disposable) { lastError = 'RESOURCE_EDIT_LOCAL_BUFFER_LIMIT'; changed(); return false; }
    disposable[1].unsubscribe(); disposable[1].unsubscribeSubmission?.(); entries.delete(disposable[0]); return true;
  }
  function get(workspaceId: string, draftId: string, options: { source?: ResourceEditSource; expectedPath?: string; initial?: ResourceEditView } = {}) {
    const key = resourceEditKey(workspaceId, draftId), existing = entries.get(key);
    if (existing) {
      if (options.expectedPath && existing.session.expectedPath && options.expectedPath !== existing.session.expectedPath
        || options.source && existing.session.source && JSON.stringify(options.source) !== JSON.stringify(existing.session.source)) { lastError = 'RESOURCE_EDIT_SOURCE_CHANGED'; changed(); return null; }
      existing.at = Date.now(); return existing.session;
    }
    if (!room()) return null;
    const session = createResourceEditSession({ api, workspaceId, draftId, ...options });
    const unsubscribe = session.subscribe(changed); entries.set(key, { session, uses: 0, at: Date.now(), unsubscribe }); changed(); return session;
  }
  return {
    api, get,
    submissionFor(session: ResourceEditSession) {
      const entry = entries.get(resourceEditKey(session.workspaceId, session.draftId));
      if (!entry || !['submit', 'continueSubmission', 'operationStatus', 'reconcileSubmission', 'cancelSubmission', 'decideSubmissionPermission', 'readExecution', 'readSubmission'].every(method => typeof api[method as keyof ResourceEditsApi] === 'function')) return null;
      if (!entry.submission) { entry.submission = createResourceSubmissionController({ session, api }); entry.unsubscribeSubmission = entry.submission.subscribe(changed); }
      return entry.submission;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, snapshot: () => version,
    error: () => lastError,
    list: (workspaceId?: string) => [...entries.values()].filter(entry => !workspaceId || entry.session.workspaceId === workspaceId),
    attach(session: ResourceEditSession) {
      const key = resourceEditKey(session.workspaceId, session.draftId), entry = entries.get(key); if (!entry) return () => {};
      entry.uses++; changed();
      return () => {
        entry.uses = Math.max(0, entry.uses - 1); entry.at = Date.now(); changed();
        queueMicrotask(() => {
          if (entry.uses) return;
          session.setComposing(false);
          void session.close(() => entry.uses === 0);
        });
      };
    },
    async openSource(source: ResourceEditSource) {
      const key = JSON.stringify(source), existing = opening.get(key); if (existing) return existing;
      if (opening.size >= 8) { lastError = 'RESOURCE_EDIT_VIEW_LIMIT'; changed(); return null; }
      const requestId = crypto.randomUUID();
      const promise = Promise.resolve().then(async () => {
        try {
          const result = await api.open({ requestId, source });
          if (!result.ok) { lastError = result.code; changed(); return null; }
          const draft = normalizeResourceTextDraft(result.draft), handle = normalizeResourceEditHandle(result.handle);
          if (!draft || !handle || handle.draftId !== draft.id) { if (handle) void api.close(handle).catch(() => {}); lastError = 'RESOURCE_EDIT_SOURCE_CHANGED'; changed(); return null; }
          const old = entries.get(resourceEditKey(draft.target.recipient.workspaceId, draft.id));
          if (old) { void api.close(handle).catch(() => {}); if (!await old.session.connect()) return null; return old.session; }
          const session = get(draft.target.recipient.workspaceId, draft.id, { initial: result, ...(source.kind === 'native' ? { source } : {}), expectedPath: draft.target.reference.path });
          if (!session) void api.close(handle).catch(() => {}); return session;
        } catch { lastError = 'RESOURCE_EDIT_SOURCE_UNAVAILABLE'; changed(); return null; }
        finally { opening.delete(key); }
      });
      opening.set(key, promise); return promise;
    },
    async flushDraft(workspaceId: string, draftId: string) { return await entries.get(resourceEditKey(workspaceId, draftId))?.session.flush() ?? true; },
    async flushAll() { const values = await Promise.all([...entries.values()].map(entry => entry.session.flush())); return values.every(Boolean); },
    hasUnsafe: () => [...entries.values()].some(entry => { const state = entry.session.snapshot(); return state.dirty || state.composing || state.saving; }),
    receive: (notice: Parameters<ResourceEditSession['receive']>[0]) => { for (const entry of entries.values()) { entry.session.receive(notice); entry.submission?.receive(notice); } },
  };
}
export type ResourceEditRegistry = ReturnType<typeof createResourceEditRegistry>;
const registries = new WeakMap<ResourceEditsApi, ResourceEditRegistry>();
export function resourceEditRegistry(api: ResourceEditsApi | undefined = window.peerResource?.resourceEdits ?? window.peerAgent?.resourceEdits) {
  if (!api) return null;
  let registry = registries.get(api); if (!registry) { registry = createResourceEditRegistry(api); registries.set(api, registry); }
  return registry;
}
