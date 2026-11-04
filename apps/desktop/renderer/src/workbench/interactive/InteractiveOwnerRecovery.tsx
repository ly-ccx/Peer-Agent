import { useState, useSyncExternalStore } from 'react';
import { useConfirm } from '../../app/components/ConfirmProvider';
import { interactiveRecoveryText } from './interactiveRecoveryText';
import type { InteractiveSession } from './interactiveSession';

export function InteractiveOwnerRecovery({ session, isZh, onAbandoned }: {
  readonly session: InteractiveSession; readonly isZh: boolean; readonly onAbandoned: () => void | Promise<void>;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  if (state.phase === 'closed') return <p role="status">{isZh ? '已放弃此视图的本地输入。' : 'Local input in this view was discarded.'}</p>;
  const fields = session.recoveryFields();
  const abandon = async () => {
    if (busy || state.savePending) return;
    setBusy(true);
    try {
      if (await confirm({ title: isZh ? '放弃旧视图的本地变更？' : 'Discard local changes in the previous view?',
        message: window.peerResource
          ? (isZh ? '这会放弃此视图里剩余的输入和阅读位置。你可以先复制输入。' : 'This discards this view’s remaining input and reading position. You can copy the input first.')
          : (isZh ? '这会放弃此视图里剩余的输入和旧 Bot 的本机布局改动。你可以先复制输入。' : 'This discards this view’s remaining input and local layout changes for the previous Bot. You can copy the input first.'),
        confirmText: isZh ? '放弃本地变更' : 'Discard local changes', cancelText: isZh ? '保留' : 'Keep', tone: 'danger' })
        && await session.abandonReplacedOwner()) await onAbandoned();
    } finally { setBusy(false); }
  };
  const retry = async () => {
    setBusy(true);
    try { session.preserveInterruptedComposition(); await session.flush(); }
    finally { setBusy(false); }
  };
  return <section className="interactive-resource-fallback interactive-owner-recovery" aria-label={isZh ? '旧视图输入恢复' : 'Previous view input recovery'}>
    <p role="status">{isZh ? '此工作区已更换 Bot。可以复制此视图保留的本地输入。' : 'This workspace now has a different Bot. You can copy the local input preserved in this view.'}</p>
    {fields.length > 0 ? <textarea readOnly rows={Math.min(8, Math.max(3, fields.length))} value={interactiveRecoveryText(session.content, state, isZh, fields)}
      aria-label={isZh ? '保留的本地输入' : 'Preserved local input'} /> : null}
    {state.savePending ? <><p>{isZh ? '原保存结果尚未确认。核对后才能放弃本地变更。' : 'The previous save is unconfirmed. Check its outcome before discarding local changes.'}</p>
      <button type="button" className="ui-button" disabled={busy} onClick={() => void retry()}>{isZh ? '核对原保存' : 'Check previous save'}</button></>
      : <button type="button" className="ui-button" disabled={busy} onClick={() => void abandon()}>{isZh ? '放弃本地变更' : 'Discard local changes'}</button>}
    {state.saveError && state.saveError !== 'interactive_owner_replaced' ? <p role="alert">{isZh ? '当前操作未确认，输入仍保留。' : 'The action is unconfirmed. Your input is preserved.'}</p> : null}
  </section>;
}
