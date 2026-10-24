import { registerSettingsNavigation, commitSettingsNavigation } from './settingsNavigation';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { Overlay } from '../../app/components/Overlay';

type Guard = { dirty: boolean; busy: boolean; save?: () => Promise<boolean>; discard: () => void };
type Context = { register: (id: string, get: () => Guard) => () => void; changed: () => void; request: (next: () => void) => boolean };
const UnsavedContext = createContext<Context | null>(null);

export function useUnsavedChanges(guard: Guard) {
  const context = useContext(UnsavedContext), id = useId(), latest = useRef(guard);
  latest.current = guard;
  useEffect(() => context?.register(id, () => latest.current), [context, id]);
  useEffect(() => { context?.changed(); }, [context, guard.dirty, guard.busy]);
}

export function useGuardedNavigation() {
  return useContext(UnsavedContext)?.request ?? ((next: () => void) => { commitSettingsNavigation(next); return true; });
}

/** Scoped navigation only. The editor owns its draft and the host owns the save receipt. */
export function UnsavedChangesProvider({ i18n, children }: { i18n: I18nRuntime; children: ReactNode }) {
  const [, setVersion] = useState(0);
  const guards = useRef(new Map<string, () => Guard>());
  const pending = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const context = useRef<Context | null>(null);
  if (!context.current) context.current = {
    changed: () => setVersion(value => value + 1),
    register: (id, get) => { guards.current.set(id, get); return () => { guards.current.delete(id); }; },
    request: next => {
      const items = [...guards.current.values()].map(get => get());
      if (!items.some(item => item.dirty || item.busy)) { commitSettingsNavigation(next); return true; }
      if (pending.current) return false;
      pending.current = next; setFailed(false); setOpen(true); return false;
    },
  };
  useEffect(() => registerSettingsNavigation(context.current!.request), []);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (![...guards.current.values()].some(get => get().dirty || get().busy)) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  const cancel = useCallback(() => { if (!saving) { pending.current = null; setOpen(false); } }, [saving]);
  const current = [...guards.current.values()].map(get => get());
  const busy = saving || current.some(item => item.busy);
  const saveable = current.filter(item => item.dirty).every(item => item.save);
  const finish = () => { const next = pending.current; pending.current = null; setOpen(false); if (next) commitSettingsNavigation(next); };
  return <UnsavedContext.Provider value={context.current}>
    {children}
    {open ? <Overlay ariaLabel={i18n.t('forms.unsavedTitle')} onClose={cancel} closeOnBackdrop={!busy} onEscape={() => busy} panelClassName="ui-leave-dialog">
      {({ requestClose }) => <>
      <h2>{i18n.t('forms.unsavedTitle')}</h2>
      <p>{i18n.t(busy ? 'forms.waitForSave' : 'forms.unsavedHint')}</p>
      {failed ? <p role="alert">{i18n.t('forms.saveFailed')}</p> : null}
      <div className="ui-form-actions">
        <button type="button" className="ui-button" data-stay data-overlay-autofocus disabled={saving} onClick={requestClose}>{i18n.t('forms.stay')}</button>
        <button type="button" className="ui-button" disabled={busy} onClick={() => { current.forEach(item => item.discard()); finish(); }}>{i18n.t('forms.discard')}</button>
        {saveable ? <button type="button" className="ui-button is-primary" disabled={busy} onClick={async () => {
          setSaving(true); setFailed(false);
          try {
            for (const get of guards.current.values()) {
              const item = get();
              if (item.dirty && (!item.save || !await item.save())) { setFailed(true); return; }
            }
            finish();
          } catch { setFailed(true); } finally { setSaving(false); }
        }}>{i18n.t(saving ? 'forms.saving' : 'forms.saveAndLeave')}</button> : null}
      </div>
      </>}
    </Overlay> : null}
  </UnsavedContext.Provider>;
}
