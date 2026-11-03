import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Renderer, useStateField, type Library, type OpenUIError } from '@openuidev/react-lang';
import { createPeerLibrary, validateState } from '@peer-agent/interactive-content';
import type { InteractiveMaterialProvenance, InteractiveStateValue } from '@peer-agent/protocol';
import { InteractiveRenderContext, peerInteractiveComponents } from './InteractiveComponents';
import type { InteractiveSession } from './interactiveSession';
import './interactive-results.css';

function StateBridge({ name, value, seen }: { name: string; value: InteractiveStateValue; seen: (key: string, value: unknown) => void }) {
  const binding = useMemo(() => ({ __reactive: 'assign' as const, target: name, expr: { k: 'StateRef' as const, n: '$value' } }), [name]);
  const field = useStateField<unknown>(name, binding);
  useLayoutEffect(() => { seen(name, field.value); if (!Object.is(field.value, value)) field.setValue(value); }, [name, value, field.value, field.setValue, seen]);
  return null;
}
function calculationMessage(code: string, isZh: boolean) {
  if (code === 'input_incomplete') return isZh ? '输入尚未完成。完成输入后更新计算，当前草稿会保留。' : 'Finish the input to update the calculation. Your draft is preserved.';
  if (code === 'division_by_zero') return isZh ? '当前条件包含除以零，无法计算。请调整条件。' : 'These conditions divide by zero. Adjust the inputs.';
  return isZh ? '当前条件无法计算。请调整条件或恢复初始条件。' : 'These conditions cannot be calculated. Adjust or reset the inputs.';
}
/** Public SDK Renderer with Peer components, governed state requests and static error recovery. */
export function InteractiveSurface({ session, provenance, isZh }: { readonly session: InteractiveSession; readonly provenance: readonly InteractiveMaterialProvenance[]; readonly isZh: boolean }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const [seenValues, setSeen] = useState<Record<string, unknown>>({}), [sdkErrors, setSdkErrors] = useState<readonly OpenUIError[]>([]);
  const [mirrorError, setMirrorError] = useState(false);
  const library = useMemo(() => createPeerLibrary({ bindings: session.content.bindings, components: peerInteractiveComponents }) as Library, [session]);
  const initial = useMemo(() => ({ ...session.snapshot().sdkValues }), [session]);
  const seen = useCallback((key: string, value: unknown) => setSeen(old => Object.is(old[key], value) ? old : { ...old, [key]: value }), []);
  const onError = useCallback((errors: OpenUIError[]) => setSdkErrors(errors), []);
  const onStateUpdate = useCallback((raw: Record<string, unknown>) => {
    // SDK notifications are a bounded presentation mirror. Drafts and save requests
    // stay ordered by the controller; an SDK callback is never a save receipt.
    try { const mirrored = validateState(raw as Record<string, InteractiveStateValue>, session.content.stateSchema).values;
      setSeen(mirrored); setMirrorError(false);
    } catch { setMirrorError(true); }
  }, [session]);
  useEffect(() => {
    if (!state.dirty || !state.writer || state.composing) return;
    const timer = setTimeout(() => { void session.flush(); }, 400);
    return () => clearTimeout(timer);
  }, [session, state.values, state.inputDrafts, state.writer, state.composing]);
  const sdkReady = Object.entries(state.sdkValues).every(([key, value]) => Object.is(seenValues[key], value));
  const error = state.calculationError ?? (mirrorError || sdkReady && sdkErrors.some(error => error.severity !== 'warning') ? 'evaluation_unavailable' : null);
  const readonly = !state.writer || ['writer_lost', 'closed'].includes(state.phase);
  return <section className="interactive-surface" aria-label={session.content.title}>
    <div className="interactive-toolbar"><p role="status">{state.phase === 'saving' ? (isZh ? '正在保存条件…' : 'Saving conditions…') : state.dirty ? (isZh ? '条件尚未保存' : 'Unsaved conditions') : state.confirmed.stateRevision ? (isZh ? '条件已保存' : 'Conditions saved') : (isZh ? '初始条件' : 'Initial conditions')}</p>
      <div>{readonly ? <button type="button" className="ui-button" disabled={state.phase === 'closed'} onClick={() => { void session.acquire(state.saveError === 'interactive_writer_busy' || state.phase === 'writer_lost'); }}>{state.saveError === 'interactive_writer_busy' || state.phase === 'writer_lost' ? (isZh ? '在此接管试算' : 'Continue calculation here') : (isZh ? '开始试算' : 'Start calculation')}</button> : <button type="button" className="ui-button" disabled={state.composing} onClick={() => session.reset()}>{isZh ? '恢复初始条件' : 'Reset conditions'}</button>}
      {state.saveError || state.dirty ? <button type="button" className="ui-button" disabled={readonly || state.composing || state.phase === 'saving'} onClick={() => { void session.flush(); }}>{isZh ? '保存条件' : 'Save conditions'}</button> : null}</div></div>
    {state.saveError ? <p className="interactive-notice" role="alert">{state.saveError === 'interactive_writer_busy' ? (isZh ? '另一个视图正在修改条件；这里保持只读。接管会使原视图停止保存。' : 'Another view is editing. This view is read-only. Taking over stops saves from the other view.') : state.phase === 'writer_lost' ? (isZh ? '保存身份已失效，当前输入保留。接管后可重试保存。' : 'The writer is no longer current. Your input is preserved. Take over to retry.') : (isZh ? '条件尚未确认保存，当前输入保留。可以重试。' : 'Saving is unconfirmed. Your input is preserved. Retry saving.')}</p> : null}
    {error ? <p className="interactive-notice" role="status">{calculationMessage(error, isZh)}</p> : null}
    <InteractiveRenderContext.Provider value={{ session, state, showResults: sdkReady && !error, provenance, isZh }}>
      <Renderer.Root response={session.content.program} library={library} initialState={initial} toolProvider={null} publishObservability={false} onError={onError} onStateUpdate={onStateUpdate}>
        {Object.entries(state.sdkValues).map(([key, value]) => <StateBridge key={key} name={key} value={value} seen={seen} />)}
        <Renderer.Content />
      </Renderer.Root>
    </InteractiveRenderContext.Provider>
    <p className="interactive-caption">{isZh ? '基于固定材料的本机试算；调整条件不会刷新来源或启动任务。' : 'Local calculation using fixed material. Changing conditions does not refresh sources or start work.'}</p>
  </section>;
}
