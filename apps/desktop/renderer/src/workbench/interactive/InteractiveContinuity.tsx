import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { PeerIcon } from '../../ui/icons';
import { useConfirm } from '../../app/components/ConfirmProvider';
import { interactiveSessionKey, interactiveSessionRegistry, type InteractiveEntry, type InteractiveSessionRegistry } from './interactiveSessionRegistry';
import { abandonInteractiveLayout, flushInteractiveLayouts, hasUnsafeInteractiveLayouts, interactivePresentationSessions } from './useInteractiveResources';
import type { ResourcePresentationSession } from './resourcePresentationSession';
import { interactiveRecoveryText } from './interactiveRecoveryText';
import { InteractiveOwnerRecovery } from './InteractiveOwnerRecovery';

function RetainedInput({ entry, isZh, registry }: { readonly entry: InteractiveEntry; readonly isZh: boolean; readonly registry: InteractiveSessionRegistry }) {
  const session = entry.session!;
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  if (!entry.uses && state.ownerReplaced && state.phase !== 'closed')
    return <InteractiveOwnerRecovery session={session} isZh={isZh} onAbandoned={async () => { await abandonInteractiveLayout(entry.reference.owner); await registry.close(entry.reference); }} />;
  if (entry.uses || !state.dirty && !state.composing) return null;
  return <details><summary><PeerIcon name="chevronRight" size={12} />{session.content.title} · {isZh ? '有未保存条件' : 'Unsaved conditions'}</summary>
    <p>{isZh ? '回到原 Bot 的交互结果继续处理，或复制保留的原始输入。保存中断输入不会改变已生效条件。' : 'Return to the original Bot’s result, or copy the preserved raw input. Saving interrupted input does not change effective conditions.'}</p>
    <textarea readOnly rows={Math.min(8, Math.max(3, Object.keys(session.content.stateSchema).length))} value={interactiveRecoveryText(session.content, state, isZh)} aria-label={isZh ? '保留的交互输入' : 'Preserved interactive input'} />
    <button type="button" className="ui-button is-compact" onClick={() => { session.preserveInterruptedComposition(); void session.flush().then(saved => { if (!saved) return session.recheckOwner(); }); }}>{isZh ? '保留中断输入并重试保存' : 'Preserve interrupted input and retry saving'}</button>
  </details>;
}
function LayoutRecovery({ session, isZh, onChecked }: { readonly session: ResourcePresentationSession; readonly isZh: boolean; readonly onChecked: (abandoned: boolean) => void }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  if (!state.dirty || state.error !== 'interactive_owner_replaced' || state.phase === 'closed') return null;
  const abandon = async () => {
    setBusy(true);
    try {
      if (await confirm({ title: isZh ? '放弃旧布局改动？' : 'Discard old layout changes?',
        message: isZh ? '工作区已更换 Bot。可以放弃旧布局中尚未保存的标签顺序和读位。' : 'This workspace has a different Bot. You can discard unsaved tab order and reading positions from the old layout.',
        confirmText: isZh ? '放弃布局改动' : 'Discard layout changes', cancelText: isZh ? '保留' : 'Keep', tone: 'danger' })) {
        onChecked(await abandonInteractiveLayout(session.owner));
      }
    } finally { setBusy(false); }
  };
  return <p>{isZh ? '旧 Bot 的布局改动无法保存。' : 'Layout changes for the previous Bot cannot be saved.'}
    <button type="button" className="ui-button is-compact" disabled={busy} onClick={() => void abandon()}>{isZh ? '放弃旧布局改动' : 'Discard old layout changes'}</button></p>;
}
export function InteractiveContinuity() {
  if (!window.peerAgent?.interactiveResults) return null;
  const registry = interactiveSessionRegistry(window.peerAgent?.interactiveResults);
  return registry ? <Continuity registry={registry} /> : null;
}
function Continuity({ registry }: { readonly registry: InteractiveSessionRegistry }) {
  const version = useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot);
  const [closing, setClosing] = useState(false), [, refresh] = useState(0);
  const keepWorking = useRef<HTMLButtonElement>(null);
  const [locale, setLocale] = useState(() => String(window.peerAgent?.initialSettings?.locale || navigator.language));
  const isZh = locale.startsWith('zh');
  useEffect(() => {
    let current = true;
    if (closing || registry.list().some(entry => !entry.uses)) void window.peerAgent?.getSettings().then(settings => {
      if (current && typeof settings.locale === 'string') setLocale(settings.locale);
    }).catch(() => {});
    return () => { current = false; };
  }, [registry, version, closing]);
  const flush = async () => {
    const [, layouts] = await Promise.all([registry.flushAll(), flushInteractiveLayouts()]);
    if (!layouts) await registry.recheckOwners();
    refresh(value => value + 1);
  };
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!registry.hasUnsafe() && !hasUnsafeInteractiveLayouts()) return;
      event.preventDefault(); event.returnValue = ''; setClosing(true); void flush();
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [registry]);
  return <aside className="resource-edit-recovery interactive-input-recovery" role="status" aria-label={isZh ? '交互输入恢复' : 'Interactive input recovery'}>
    {closing ? <><p>{registry.hasUnsafe() || hasUnsafeInteractiveLayouts()
      ? (isZh ? '条件或布局尚未确认保存，窗口已保留。完成输入或处理保存问题后再关闭或刷新。' : 'Conditions or layout are not confirmed saved. This window is preserved. Finish input or resolve saving before closing or reloading.')
      : (isZh ? '现在可以重新关闭或刷新。' : 'You can close or reload again.')}</p>
      <button type="button" className="ui-button is-compact" onClick={() => void flush()}>{isZh ? '重试保存' : 'Retry saving'}</button>
      <button ref={keepWorking} type="button" className="ui-button is-compact" onClick={() => setClosing(false)}>{isZh ? '继续工作' : 'Keep working'}</button></> : null}
    {registry.list().filter(entry => entry.session).map(entry => <RetainedInput key={interactiveSessionKey(entry.reference)} entry={entry} isZh={isZh} registry={registry} />)}
    {closing ? interactivePresentationSessions().map(session => <LayoutRecovery key={JSON.stringify(session.owner)} session={session} isZh={isZh}
      onChecked={abandoned => { refresh(value => value + 1); if (abandoned) keepWorking.current?.focus({ preventScroll: true }); }} />) : null}
  </aside>;
}
