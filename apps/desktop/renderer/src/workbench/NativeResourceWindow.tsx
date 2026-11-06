import { resourceEditRegistry } from './editing/resourceEditRegistry';
import { ResourceFeedbackProvider } from './feedback/ResourceFeedbackContext';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ResourceWindowContext } from '@peer-agent/protocol';
import { PeerIcon } from '../ui/icons';
import { useConfirm } from '../app/components/ConfirmProvider';
import { NativeResourceDirectory, NativeResourceDocument } from './NativeResourceRead';
import { NativeResourceComparison } from './NativeResourceComparison';
import { NativeNavigationProvider, useNativeNavigation } from './NativeNavigation';
import { NativeInteractiveResource } from './interactive/InteractiveResource';
import { interactiveSessionRegistry } from './interactive/interactiveSessionRegistry';
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
  if (context) return <ResourceFeedbackProvider recipient={context.resource.kind !== 'interactive' && window.peerResource?.prepareFeedback ? { workspaceId: context.owner.workspaceId, conversationId: context.owner.conversationId } : null} prepare={feedback => window.peerResource!.prepareFeedback!({ identity: context, feedback })}><NativeNavigationProvider context={context}><NativeResourceSurface context={context} isZh={isZh} /></NativeNavigationProvider></ResourceFeedbackProvider>;
  return <main className="resource-native-shell"><p role={failure ? 'alert' : 'status'}>{failure ?? (isZh ? '正在打开只读视图…' : 'Opening read-only view…')}</p>
    {failure ? <button type="button" className="ui-button" onClick={() => setRetry(value => value + 1)}>{isZh ? '重试' : 'Retry'}</button> : null}</main>;
}

function NativeResourceSurface({ context, isZh }: { readonly context: ResourceWindowContext; readonly isZh: boolean }) {
  const [failure, setFailure] = useState<string | null>(null), [returning, setReturning] = useState(false);
  const [discardingReading, setDiscardingReading] = useState(false);
  const confirm = useConfirm();
  const navigation = useNativeNavigation()!;
  const saving = useSyncExternalStore(navigation.subscribe, navigation.snapshot, navigation.snapshot);
  const closeButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (saving.abandoned) closeButton.current?.focus({ preventScroll: true }); }, [saving.abandoned]);
  const identity = { viewId: context.viewId, windowId: context.windowId, generation: context.generation };
  const flush = async () => {
    const editors = resourceEditRegistry(), interactive = interactiveSessionRegistry();
    const saved = await Promise.all([editors?.flushAll() ?? true, interactive?.flushAll() ?? true, navigation.flush()]);
    if (!saved[2]) await interactive?.recheckOwners();
    return saved.every(Boolean) && !editors?.hasUnsafe() && !interactive?.hasUnsafe();
  };
  useEffect(() => window.peerResource?.onCloseBlocked?.(notice => {
    if (notice.identity.viewId !== context.viewId || notice.identity.windowId !== context.windowId || notice.identity.generation !== context.generation) return;
    setFailure(notice.reason === 'save_failed'
      ? (isZh ? '上次关闭时，输入或阅读位置未安全保存，窗口已保留。确认保存后可再次关闭。' : 'The previous close was blocked because input or reading position was not safely saved. Confirm saving, then close again.')
      : (isZh ? '上次关闭未收到保存确认，窗口已保留。可重试关闭。' : 'The previous close did not receive save confirmation. This window is preserved. Retry closing.'));
  }), [context.viewId, context.windowId, context.generation, isZh]);
  const returnToSource = async () => {
    if (returning) return;
    setReturning(true); setFailure(null);
    try { if (!await flush()) { setFailure(isZh ? '输入或阅读位置尚未保存，当前窗口保留。' : 'Input or reading position is not saved. This window is preserved.'); return; } const result = await window.peerResource!.returnToSource(identity); if (!result.ok) setFailure(isZh ? '原会话窗口或来源已不可用。当前阅读保留。' : 'The original conversation window or source is unavailable. Your reading is preserved.');
      else if (result.returnStatus === 'source_tab_closed') setFailure(isZh ? '原标签已关闭，已返回原会话。此窗口继续保留。' : 'The original tab was closed. Returned to the conversation; this view is preserved.'); }
    catch { setFailure(isZh ? '暂时无法返回原会话，可重试。' : 'Unable to return to the source conversation. Retry.'); }
    finally { setReturning(false); }
  };
  const discardReading = async () => {
    setDiscardingReading(true);
    try {
      if (await confirm({ title: isZh ? '放弃本地读位？' : 'Discard the local reading position?',
        message: isZh ? '工作区已更换 Bot。仅放弃此窗口尚未保存的读位。' : 'This workspace has a different Bot. This discards the unsaved reading position in this window.',
        confirmText: isZh ? '放弃读位' : 'Discard reading position', cancelText: isZh ? '保留' : 'Keep', tone: 'danger' })
        && await navigation.abandonAfterReplacement()) setFailure(null);
    } finally { setDiscardingReading(false); }
  };
  const path = context.resource.kind === 'interactive' ? null : context.resource.reference.path;
  const title = context.resource.kind === 'interactive' ? context.title || (isZh ? '交互结果' : 'Interactive result') : path?.split(/[\\/]/).pop() || (isZh ? '只读视图' : 'Read-only view');
  return <main className="resource-native-shell">
    <header className="resource-native-header">
      <PeerIcon name={context.resource.kind === 'directory' ? 'folder' : 'fileText'} size={16} />
      <h1 title={path ?? title}>{title}</h1>
      <span className="resource-source-label">{isZh ? '独立视图' : 'Separate view'}</span>
      <button type="button" className="ui-button resource-native-icon" disabled={returning} aria-label={isZh ? '返回原会话' : 'Return to source conversation'} title={isZh ? '返回原会话' : 'Return to source conversation'} onClick={() => void returnToSource()}><PeerIcon name="back" size={16} /></button>
      <button ref={closeButton} type="button" className="ui-button resource-native-icon" aria-label={isZh ? '关闭此窗口' : 'Close this window'} onClick={() => { void flush().then(saved => { if (saved) return window.peerResource!.close(identity); setFailure(isZh ? '输入或阅读位置尚未保存，当前窗口保留。' : 'Input or reading position is not saved. This window is preserved.'); }).catch(() => setFailure(isZh ? '暂时无法关闭，请使用窗口关闭按钮重试。' : 'Unable to close. Retry with the native window close button.')); }}><PeerIcon name="close" size={16} /></button>
    </header>
    {failure ? <p className="resource-native-notice" role="alert">{failure}</p> : null}
    {!saving.persisted && !saving.abandoned ? <p className="resource-native-notice" role="status">
      {saving.error === 'owner_replaced'
        ? (isZh ? '旧 Bot 的阅读位置无法保存。' : 'The previous Bot’s reading position cannot be saved.')
        : (isZh ? '阅读位置暂未保存，当前阅读保留。' : 'Reading position was not saved. Your current reading is preserved.')}
      {saving.error === 'owner_replaced'
        ? <button type="button" className="ui-button is-compact" disabled={discardingReading} onClick={() => void discardReading()}>{isZh ? '放弃本地读位' : 'Discard local reading position'}</button>
        : <button type="button" className="ui-button is-compact" onClick={() => void navigation.retry()}>{isZh ? '重试保存' : 'Retry save'}</button>}
    </p> : null}
    {path ? <p className="resource-native-path">{path}</p> : null}<div className="resource-native-content">{context.resource.kind === 'interactive' ? <NativeInteractiveResource context={context} isZh={isZh} /> : context.resource.kind === 'directory' ? <NativeResourceDirectory context={context} isZh={isZh} /> : context.resource.kind === 'comparison' ? <NativeResourceComparison context={context} isZh={isZh} /> : <NativeResourceDocument context={context} isZh={isZh} />}</div>
  </main>;
}
