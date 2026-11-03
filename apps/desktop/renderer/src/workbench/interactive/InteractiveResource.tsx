import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import type { InteractiveResultReference, InteractiveResultsApi, ResourceWindowContext } from '@peer-agent/protocol';
import { MotionDetails } from '../../app/components/MotionDetails';
import { deferPanel } from '../../app/components/deferPanel';
import { PeerIcon } from '../../ui/icons';
import { SourceViewer } from '../file-preview/SourceViewer';
import { useDocumentReadingPosition } from '../useDocumentReadingPosition';
import { useNativeNavigation } from '../NativeNavigation';
import { interactiveSessionKey, interactiveSessionRegistry } from './interactiveSessionRegistry';
import type { InteractiveSession } from './interactiveSession';
import './interactive-resource.css';

function SavedSummary({ title, text, isZh }: { readonly title: string; readonly text: string; readonly isZh: boolean }) {
  return <section className="interactive-resource-fallback"><h2>{title}</h2><p className="resource-source-label">{isZh ? '已保存的模型摘要，未验证' : 'Saved model summary, unverified'}</p><p>{text}</p></section>;
}
function UnavailableSurface({ session, isZh, onUnavailable, recoverView }: { readonly session: InteractiveSession; readonly isZh: boolean;
  readonly onUnavailable?: () => void; readonly recoverView: () => Promise<boolean> }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  useLayoutEffect(() => { onUnavailable?.(); }, [onUnavailable]);
  const recover = async () => {
    if (busy) return; setBusy(true); setNotice(null);
    try {
      session.preserveInterruptedComposition();
      if (!await session.flush() || session.snapshot().dirty || !await recoverView()) {
        setNotice(isZh ? '保存或打开尚未确认，当前输入仍保留，可重试。' : 'Saving or opening is unconfirmed. Your input is preserved; retry.'); return;
      }
      setNotice(isZh ? '已打开视图，原试算仍保留。' : 'The view was opened. Your original calculation is preserved.');
    } catch { setNotice(isZh ? '暂时无法重新打开，当前输入仍保留。' : 'Unable to reopen. Your input is preserved.'); }
    finally { setBusy(false); }
  };
  return <div className="interactive-resource-fallback" role="alert">
    <p>{isZh ? '试算视图暂时无法加载。当前输入和固定结果仍保留，可保存草稿后重新打开。' : 'The calculation view could not load. Your input and fixed result are preserved. Save drafts before reopening.'}</p>
    <button type="button" className="ui-button" disabled={busy} onClick={() => void recover()}>{window.peerResource ? (isZh ? '保存草稿并重新加载视图' : 'Save drafts and reload view') : (isZh ? '保存草稿并打开独立视图' : 'Save drafts and open separate view')}</button>
    {state.phase === 'writer_lost' || state.saveError === 'interactive_writer_busy' ? <button type="button" className="ui-button" disabled={busy} onClick={() => { void session.acquire(true); }}>{isZh ? '在此接管保存' : 'Take over saving here'}</button> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <SavedSummary title={session.content.title} text={session.content.textFallback} isZh={isZh} />
  </div>;
}
type SurfaceProps = ComponentProps<typeof import('./InteractiveSurface')['InteractiveSurface']> & {
  readonly onUnavailable?: () => void; readonly recoverView: () => Promise<boolean>;
};
const Surface = deferPanel<(props: SurfaceProps) => ReactNode>(() => import('./InteractiveSurface').then(module => ({ default: module.InteractiveSurface })), {
  renderError: props => <UnavailableSurface {...props} />,
});
function failureText(code: string | null, isZh: boolean) {
  if (code === 'interactive_open_cancelled') return isZh ? '已取消打开这份视图。原结果仍保留，可重新打开。' : 'Opening this view was cancelled. The original result is preserved.';
  if (['incompatible_catalog', 'incompatible_state_schema', 'interactive_storage_incompatible'].includes(code ?? '')) return isZh ? '当前版本无法安全运行这份结果。已保留保存的摘要和程序。' : 'This version cannot safely run the result. The saved summary and program are preserved.';
  if (['interactive_scope_denied', 'interactive_view_stale'].includes(code ?? '')) return isZh ? '结果归属或视图已变化。当前内容保留，请重新打开原结果。' : 'The owner or view has changed. Reopen the original result.';
  if (code === 'interactive_content_cleaned') return isZh ? '结果正文已清理，不能恢复历史计算。' : 'The result content was cleaned. The historical calculation cannot be restored.';
  if (code === 'interactive_state_corrupt') return isZh ? '保存的条件无法核对，已保留原检查点。当前只显示保存的摘要。' : 'The saved conditions could not be checked. The checkpoint is preserved; only the saved summary is shown.';
  return isZh ? '此设备暂时无法打开结果。没有重新取数或执行工作，可以重试。' : 'This device cannot open the result. No data or work was rerun. Retry opening.';
}

export function InteractiveResource({ reference, api, active, isZh, onReady, onUnavailable, onRecoverView }: { readonly reference: InteractiveResultReference; readonly api?: InteractiveResultsApi;
  readonly active: boolean; readonly isZh: boolean; readonly onReady?: () => void; readonly onUnavailable?: () => void; readonly onRecoverView?: () => Promise<boolean> }) {
  const registry = useMemo(() => interactiveSessionRegistry(api), [api]);
  const key = interactiveSessionKey(reference);
  useSyncExternalStore(registry?.subscribe ?? (() => () => {}), registry?.snapshot ?? (() => 0), () => 0);
  const [openingError, setOpeningError] = useState<string | null>(null);
  const entry = registry?.get(reference), session = entry?.session;
  const open = useCallback(() => {
    setOpeningError(null);
    if (!registry) { setOpeningError('interactive_bridge_unavailable'); return; }
    void registry.open(reference).catch(() => setOpeningError('interactive_source_unavailable'));
  }, [registry, key]);
  useEffect(() => { if (active) open(); }, [open, active]);
  useEffect(() => {
    if (!session || !active) return;
    if (!session.snapshot().writer) void session.acquire();
    return () => { void session.flush(); };
  }, [session, active]);
  if (!active) return null;
  const failure = openingError ?? entry?.error;
  return <div className="interactive-resource">
    {(!entry || entry.phase === 'opening') && !failure ? <div role="status"><p>{isZh ? '正在打开固定版本…' : 'Opening the fixed version…'}</p>
      {registry && entry ? <button type="button" className="ui-button" onClick={() => { void registry.close(reference).then(ok => { if (ok) setOpeningError('interactive_open_cancelled'); }); }}>{isZh ? '取消打开' : 'Cancel opening'}</button> : null}</div> : null}
    {failure ? <div role="alert"><p>{failureText(failure, isZh)}</p><button type="button" className="ui-button" onClick={open}>{isZh ? '重试打开' : 'Retry opening'}</button></div> : null}
    {entry?.phase === 'ready' && session && entry.opened ? <Surface session={session} provenance={entry.opened.result.provenance} isZh={isZh} onReady={onReady}
      onUnavailable={onUnavailable} recoverView={onRecoverView ?? (async () => !!(await window.peerAgent?.resourceWindowOpen?.({ resource: { kind: 'interactive', reference } }))?.ok)} />
      : entry?.summary ? <SavedSummary title={entry.summary.title} text={entry.summary.textFallback} isZh={isZh} /> : null}
    {entry?.opened ? <MotionDetails className="interactive-resource-program"><summary><PeerIcon name="chevronRight" size={12} />{isZh ? '查看保存的程序' : 'View saved program'}</summary>
      <SourceViewer content={entry.opened.result.content.program} language="text" isZh={isZh} emptyLabel={isZh ? '程序为空。' : 'Empty program.'} />
    </MotionDetails> : null}
  </div>;
}

export function NativeInteractiveResource({ context, isZh }: { readonly context: ResourceWindowContext; readonly isZh: boolean }) {
  if (context.resource.kind !== 'interactive') throw Error('invalid_interactive_resource');
  const navigation = useNativeNavigation();
  const [ready, setReady] = useState(false);
  const contentReady = useCallback(() => setReady(true), []);
  const contentUnavailable = useCallback(() => setReady(false), []);
  const recoverView = useCallback(async () => {
    const registry = interactiveSessionRegistry(window.peerResource?.interactiveResults);
    if (!registry || !await registry.flushAll() || registry.hasUnsafe() || !await navigation?.flush()) return false;
    window.location.reload(); return true;
  }, [navigation]);
  const onRemember = useCallback((_key: string, point: { top: number; left: number }) => navigation?.update(point), [navigation]);
  const reading = useDocumentReadingPosition(`interactive:${context.viewId}`, 'interactive', true, ready, undefined,
    { key: 'interactive', initial: { interactive: context.navigation ?? { top: 0, left: 0 } }, onRemember });
  useLayoutEffect(() => navigation?.registerCapture(() => ready ? reading.capture() : undefined), [navigation, reading.capture, ready]);
  return <div className="resource-interactive-body" ref={reading.ref} onScroll={reading.onScroll}>
    <InteractiveResource reference={context.resource.reference} api={window.peerResource?.interactiveResults} active isZh={isZh}
      onReady={contentReady} onUnavailable={contentUnavailable} onRecoverView={recoverView} />
  </div>;
}
