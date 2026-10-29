import { resourceEditRegistry } from './editing/resourceEditRegistry';
import { ResourceFeedbackProvider } from './feedback/ResourceFeedbackContext';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ResourceWindowContext } from '@peer-agent/protocol';
import { PeerIcon } from '../ui/icons';
import { NativeResourceDirectory, NativeResourceDocument } from './NativeResourceRead';
import { NativeResourceComparison } from './NativeResourceComparison';
import { NativeNavigationProvider, useNativeNavigation } from './NativeNavigation';
import './resource-workspace.css';
import './resource-native-window.css';

export function NativeResourceWindow() {
  const [context, setContext] = useState<ResourceWindowContext | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const isZh = (window.peerResource?.initialLocale || navigator.language).startsWith('zh');
  useEffect(() => {
    let current = true;
    const api = window.peerResource;
    setFailure(null);
    void (async () => {
      if (!api || typeof api.onCheckpointRequest !== 'function' || typeof api.acknowledgeCheckpoint !== 'function') throw new Error('source_unavailable');
      const binding = await api.bootstrap();
      if (!binding.ok) throw new Error(binding.status);
      const ready = await api.ready({ viewId: binding.context.viewId, windowId: binding.context.windowId, generation: binding.context.generation });
      if (!ready.ok) throw new Error(ready.status);
      if (current) setContext(ready.context);
    })().catch(() => { if (current) setFailure(isZh ? '此视图的来源已失效或暂不可用。' : 'The source for this view is unavailable.'); });
    return () => { current = false; };
  }, [retry, isZh]);
  if (context) return <ResourceFeedbackProvider recipient={window.peerResource?.prepareFeedback ? { workspaceId: context.owner.workspaceId, conversationId: context.owner.conversationId } : null} prepare={feedback => window.peerResource!.prepareFeedback!({ identity: context, feedback })}><NativeNavigationProvider context={context}><NativeResourceSurface context={context} isZh={isZh} /></NativeNavigationProvider></ResourceFeedbackProvider>;
  return <main className="resource-native-shell"><p role={failure ? 'alert' : 'status'}>{failure ?? (isZh ? '正在打开只读视图…' : 'Opening read-only view…')}</p>
    {failure ? <button type="button" className="ui-button" onClick={() => setRetry(value => value + 1)}>{isZh ? '重试' : 'Retry'}</button> : null}</main>;
}

function NativeResourceSurface({ context, isZh }: { readonly context: ResourceWindowContext; readonly isZh: boolean }) {
  const [failure, setFailure] = useState<string | null>(null), [returning, setReturning] = useState(false);
  const navigation = useNativeNavigation()!;
  const saving = useSyncExternalStore(navigation.subscribe, navigation.snapshot, navigation.snapshot);
  const identity = { viewId: context.viewId, windowId: context.windowId, generation: context.generation };
  useEffect(() => window.peerResource?.onCloseBlocked?.(notice => {
    if (notice.identity.viewId !== context.viewId || notice.identity.windowId !== context.windowId || notice.identity.generation !== context.generation) return;
    setFailure(notice.reason === 'save_failed'
      ? (isZh ? '草稿或阅读位置尚未安全保存，窗口已保留。完成输入或重试保存后，再关闭窗口。' : 'Drafts or reading position are not safely saved. This window is preserved. Finish input or retry saving, then close again.')
      : (isZh ? '保存确认尚未返回，窗口已保留。请稍后重新关闭。' : 'Save confirmation has not returned. This window is preserved. Try closing again shortly.'));
  }), [context.viewId, context.windowId, context.generation, isZh]);
  const returnToSource = async () => {
    if (returning) return;
    setReturning(true); setFailure(null);
    try { if (!(await resourceEditRegistry()?.flushAll() ?? true) || !await navigation.flush()) { setFailure(isZh ? '草稿或阅读位置尚未保存，当前窗口保留。' : 'Drafts or reading position are not saved. This window is preserved.'); return; } const result = await window.peerResource!.returnToSource(identity); if (!result.ok) setFailure(isZh ? '原会话窗口或来源已不可用。当前阅读保留。' : 'The original conversation window or source is unavailable. Your reading is preserved.');
      else if (result.returnStatus === 'source_tab_closed') setFailure(isZh ? '原标签已关闭，已返回原会话。此窗口继续保留。' : 'The original tab was closed. Returned to the conversation; this view is preserved.'); }
    catch { setFailure(isZh ? '暂时无法返回原会话，可重试。' : 'Unable to return to the source conversation. Retry.'); }
    finally { setReturning(false); }
  };
  const path = context.resource.reference.path;
  return <main className="resource-native-shell">
    <header className="resource-native-header">
      <PeerIcon name={context.resource.kind === 'directory' ? 'folder' : 'fileText'} size={16} />
      <h1 title={path}>{path.split(/[\\/]/).pop() || (isZh ? '只读视图' : 'Read-only view')}</h1>
      <span className="resource-source-label">{isZh ? '独立视图' : 'Separate view'}</span>
      <button type="button" className="ui-button resource-native-icon" disabled={returning} aria-label={isZh ? '返回原会话' : 'Return to source conversation'} title={isZh ? '返回原会话' : 'Return to source conversation'} onClick={() => void returnToSource()}><PeerIcon name="back" size={16} /></button>
      <button type="button" className="ui-button resource-native-icon" aria-label={isZh ? '关闭此窗口' : 'Close this window'} onClick={() => { void Promise.all([resourceEditRegistry()?.flushAll() ?? Promise.resolve(true), navigation.flush()]).then(([drafts, navigation]) => { if (drafts && navigation) return window.peerResource!.close(identity); setFailure(isZh ? '草稿或阅读位置尚未保存，当前窗口保留。' : 'Drafts or reading position are not saved. This window is preserved.'); }).catch(() => setFailure(isZh ? '暂时无法关闭，请使用窗口关闭按钮重试。' : 'Unable to close. Retry with the native window close button.')); }}><PeerIcon name="close" size={16} /></button>
    </header>
    {failure ? <p className="resource-native-notice" role="alert">{failure}</p> : null}
    {!saving.persisted ? <p className="resource-native-notice" role="status">{isZh ? '阅读位置暂未保存；当前阅读保留。' : 'Reading position was not saved. Your current reading is preserved.'}<button type="button" className="ui-button is-compact" onClick={() => void navigation.retry()}>{isZh ? '重试保存' : 'Retry save'}</button></p> : null}
    <p className="resource-native-path">{path}</p><div className="resource-native-content">{context.resource.kind === 'directory' ? <NativeResourceDirectory context={context} isZh={isZh} /> : context.resource.kind === 'comparison' ? <NativeResourceComparison context={context} isZh={isZh} /> : <NativeResourceDocument context={context} isZh={isZh} />}</div>
  </main>;
}
