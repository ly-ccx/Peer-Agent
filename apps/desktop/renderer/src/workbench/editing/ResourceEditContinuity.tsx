import { PeerIcon } from '../../ui/icons';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { resourceEditRegistry, type ResourceEditRegistry } from './resourceEditRegistry';
import './resource-editing.css';
export function ResourceEditAppFrame({ children }: { readonly children: ReactNode }) {
  return <div className="resource-edit-app-root"><ResourceEditContinuity /><div className="resource-edit-app-content">{children}</div></div>;
}
export function ResourceEditContinuity() {
  const registry = resourceEditRegistry();
  return registry ? <Continuity registry={registry} /> : null;
}
function Continuity({ registry }: { readonly registry: ResourceEditRegistry }) {
  useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot);
  const [closing, setClosing] = useState(false);
  const isZh = (window.peerResource?.initialLocale || navigator.language).startsWith('zh');
  useEffect(() => {
    const dispose = registry.api.onChanged(registry.receive);
    const unload = (event: BeforeUnloadEvent) => {
      if (!registry.hasUnsafe()) return;
      event.preventDefault(); event.returnValue = ''; setClosing(true);
      void registry.flushAll();
    };
    window.addEventListener('beforeunload', unload);
    return () => { dispose(); window.removeEventListener('beforeunload', unload); };
  }, [registry]);
  const unsafe = registry.list().filter(entry => { const state = entry.session.snapshot(); return !entry.uses && (state.dirty || state.composing); });
  if (!closing && !unsafe.length) return null;
  return <aside className="resource-edit-recovery" role="status" aria-label={isZh ? '草稿恢复' : 'Draft recovery'}>
    {closing ? <p>{registry.hasUnsafe() ? (isZh ? '草稿尚未安全保存，窗口已保留。完成输入或处理保存问题后再关闭或刷新。' : 'Drafts are not safely saved. This window is preserved. Finish input or resolve saving before closing or reloading.')
      : (isZh ? '草稿已保存，现在可以重新关闭或刷新。' : 'Drafts are saved. You can close or reload again.')}</p> : null}
    {unsafe.map(({ session }) => <details key={`${session.workspaceId}:${session.draftId}`}><summary><PeerIcon name="chevronRight" size={12} />{isZh ? '有未保存的草稿输入' : 'Unsaved draft input'} · {session.snapshot().view?.draft.target.reference.path ?? session.draftId}</summary>
      <p>{isZh ? '回到原 Bot 的草稿处理保存问题；也可从这里选中复制保留输入。' : 'Return to the original Bot’s draft to resolve saving, or select and copy this input.'}</p>
      <textarea readOnly value={session.snapshot().text} aria-label={isZh ? '保留的未保存输入' : 'Preserved unsaved input'} />
      <button type="button" className="ui-button is-compact" onClick={() => void session.flush()}>{isZh ? '重试保存草稿' : 'Retry draft save'}</button>
    </details>)}
    {closing ? <button type="button" className="ui-button is-compact" onClick={() => setClosing(false)}>{isZh ? '继续工作' : 'Keep working'}</button> : null}
  </aside>;
}
