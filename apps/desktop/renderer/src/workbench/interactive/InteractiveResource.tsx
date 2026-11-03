import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { InteractiveResultReference, InteractiveResultsApi, ResourceWindowContext } from '@peer-agent/protocol';
import { MotionDetails } from '../../app/components/MotionDetails';
import { PeerIcon } from '../../ui/icons';
import { SourceViewer } from '../file-preview/SourceViewer';
import { useDocumentReadingPosition } from '../useDocumentReadingPosition';
import { useNativeNavigation } from '../NativeNavigation';
import { interactiveSessionKey, interactiveSessionRegistry } from './interactiveSessionRegistry';
import './interactive-resource.css';

const Surface = lazy(() => import('./InteractiveSurface').then(module => ({ default: module.InteractiveSurface })));
function failureText(code: string | null, isZh: boolean) {
  if (code === 'interactive_open_cancelled') return isZh ? '已取消打开这份视图。原结果仍保留，可重新打开。' : 'Opening this view was cancelled. The original result is preserved.';
  if (['incompatible_catalog', 'incompatible_state_schema', 'interactive_storage_incompatible'].includes(code ?? '')) return isZh ? '当前版本无法安全运行这份结果。已保留保存的摘要和程序。' : 'This version cannot safely run the result. The saved summary and program are preserved.';
  if (['interactive_scope_denied', 'interactive_view_stale'].includes(code ?? '')) return isZh ? '结果归属或视图已变化。当前内容保留，请重新打开原结果。' : 'The owner or view has changed. Reopen the original result.';
  if (code === 'interactive_content_cleaned') return isZh ? '结果正文已清理，不能恢复历史计算。' : 'The result content was cleaned. The historical calculation cannot be restored.';
  if (code === 'interactive_state_corrupt') return isZh ? '保存的条件无法核对，已保留原检查点。当前只显示保存的摘要。' : 'The saved conditions could not be checked. The checkpoint is preserved; only the saved summary is shown.';
  return isZh ? '此设备暂时无法打开结果。没有重新取数或执行工作，可以重试。' : 'This device cannot open the result. No data or work was rerun. Retry opening.';
}

export function InteractiveResource({ reference, api, active, isZh, onReady }: { readonly reference: InteractiveResultReference; readonly api?: InteractiveResultsApi;
  readonly active: boolean; readonly isZh: boolean; readonly onReady?: () => void }) {
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
    {entry?.phase === 'ready' && session && entry.opened ? <Suspense fallback={<p role="status">{isZh ? '正在准备试算控件…' : 'Preparing calculation controls…'}</p>}>
      <Surface session={session} provenance={entry.opened.result.provenance} isZh={isZh} onReady={onReady} />
    </Suspense> : entry?.summary ? <section className="interactive-resource-fallback"><h2>{entry.summary.title}</h2><p className="resource-source-label">{isZh ? '已保存的模型摘要，未验证' : 'Saved model summary, unverified'}</p><p>{entry.summary.textFallback}</p></section> : null}
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
  const onRemember = useCallback((_key: string, point: { top: number; left: number }) => navigation?.update(point), [navigation]);
  const reading = useDocumentReadingPosition(`interactive:${context.viewId}`, 'interactive', true, ready, undefined,
    { key: 'interactive', initial: { interactive: context.navigation ?? { top: 0, left: 0 } }, onRemember });
  useLayoutEffect(() => navigation?.registerCapture(() => ready ? reading.capture() : undefined), [navigation, reading.capture, ready]);
  return <div className="resource-interactive-body" ref={reading.ref} onScroll={reading.onScroll}>
    <InteractiveResource reference={context.resource.reference} api={window.peerResource?.interactiveResults} active isZh={isZh} onReady={contentReady} />
  </div>;
}
