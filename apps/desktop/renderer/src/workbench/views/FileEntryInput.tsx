import { PeerIcon } from '../../ui/icons';
import { useId } from 'react';
import { useCompositionGuard } from '../../app/hooks/useCompositionGuard';
/** A filename remains a draft on blur; only a non-composing Enter requests creation. */
export function FileEntryInput({ value, busy, error, kind, isZh, onChange, onCommit, onCancel }: {
  readonly value: string; readonly busy: boolean; readonly error: string | null;
  readonly kind: 'file' | 'dir'; readonly isZh: boolean;
  readonly onChange: (value: string) => void; readonly onCommit: () => void; readonly onCancel: () => void;
}) {
  const guard = useCompositionGuard(), id = useId();
  const label = kind === 'dir' ? (isZh ? '新建文件夹' : 'New folder') : (isZh ? '新建文件' : 'New file');
  return <>
    <input className="ui-input workbench-tree-draft-input" autoFocus readOnly={busy} aria-busy={busy} value={value}
      placeholder={label} aria-label={label} aria-invalid={Boolean(error)} aria-describedby={error ? id : undefined}
      onChange={event => onChange(event.target.value)} onCompositionStart={event => guard.start(event.currentTarget)}
      onCompositionEnd={event => guard.end(event.currentTarget)} onKeyUp={event => guard.keyUp(event.nativeEvent)}
      onKeyDown={event => {
        if (guard.keyDown(event.nativeEvent)) { event.stopPropagation(); return; }
        if (event.key !== 'Enter' && event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation();
        if (busy || event.repeat) return;
        if (event.key === 'Enter') onCommit(); else onCancel();
      }} />
    <button type="button" className="ui-button is-icon is-compact" aria-disabled={busy} aria-label={isZh ? '确认创建' : 'Create entry'}
      onClick={() => { if (!busy && !guard.active()) onCommit(); }}><PeerIcon name="check" size={14} /></button>
    <button type="button" className="ui-button is-icon is-compact" aria-disabled={busy} aria-label={isZh ? '取消新建' : 'Cancel creation'}
      onClick={() => { if (!busy) onCancel(); }}><PeerIcon name="close" size={14} /></button>
    {error ? <span id={id} className="workbench-tree-draft-error" role="alert">{error}</span> : null}
  </>;
}
