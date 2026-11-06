import { PeerIcon } from '../../ui/icons';
import { useState, useSyncExternalStore } from 'react';
import type { ResourceEditDraftInfo, ResourceEditScope, ResourceTextSnapshot } from '@peer-agent/protocol';
import { useResourceRead } from '../../ui/resources/useResourceState';
import { useConfirm } from '../../app/components/ConfirmProvider';
import { SourceViewer } from '../file-preview/SourceViewer';
import { highlightLanguageForPath } from '../file-preview/fileTypes';
import { resourceEditRegistry } from './resourceEditRegistry';
import { resourceEditMessage, resourceEditOutcome } from './resourceEditMessages';
import './resource-editing.css';
import './resource-draft-library.css';

const fileLabel = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
export function ResourceDraftLibrary({ scope, active, isZh, onOpen }: { readonly scope: ResourceEditScope; readonly active: boolean; readonly isZh: boolean; readonly onOpen: (draft: ResourceEditDraftInfo) => void }) {
  const registry = resourceEditRegistry(), confirm = useConfirm();
  const [historyOpen, setHistoryOpen] = useState(false), [cursor, setCursor] = useState<string | undefined>();
  const [previous, setPrevious] = useState<(string | undefined)[]>([]), [historyCursor, setHistoryCursor] = useState<string | undefined>();
  const [historyPrevious, setHistoryPrevious] = useState<(string | undefined)[]>([]);
  const [selected, setSelected] = useState<ResourceTextSnapshot | null>(null), [error, setError] = useState<string | null>(null), [pending, setPending] = useState(false);
  useSyncExternalStore(registry?.subscribe ?? (() => () => {}), registry?.snapshot ?? (() => 0), registry?.snapshot ?? (() => 0));
  const key = JSON.stringify(scope);
  const index = useResourceRead(`draft-index:${key}:${cursor}`, () => registry!.api.list({ ...scope, cursor, limit: 32 }), active && !!registry);
  const history = useResourceRead(`draft-history:${key}:${historyCursor}`, () => registry!.api.history({ ...scope, cursor: historyCursor, limit: 32 }), active && historyOpen && !!registry);
  const content = useResourceRead(`draft-snapshot:${key}:${selected?.id}`, () => registry!.api.readSnapshot({ ...scope, id: selected!.id }), active && !!selected && !!registry);
  if (!registry) return null;
  const drafts = index.value?.ok ? index.value.drafts : [], operations = index.value?.ok ? index.value.operations : [];
  const items = history.value?.ok ? history.value.items : [];
  const local = registry.list(scope.workspaceId).filter(entry => entry.session.snapshot().dirty && !drafts.some(draft => draft.id === entry.session.draftId));
  const moreRecords = index.value?.ok && !!index.value.nextCursor;
  const moreSnapshots = history.value?.ok && !!history.value.nextCursor;
  const mutate = async (type: 'cleanup' | 'archive' | 'delivery', id: string) => {
    if (pending) return; setPending(true); setError(null);
    try {
      if (!await confirm({ title: isZh ? '整理本机草稿历史？' : 'Manage local draft history?', message: type === 'archive'
        ? (isZh ? '归档已结算操作，保留稳定请求身份和执行回执，不重复执行。' : 'Archive the settled operation while retaining its request identity and receipt. Nothing is replayed.')
        : (isZh ? '清理所选历史的留存正文。原文件、当前草稿和执行依据保留；已清理的正文不能再次预览。' : 'Clear retained historical text. Original files, current drafts and evidence remain. Cleared text cannot be previewed.'),
        confirmText: isZh ? '确认整理' : 'Confirm', cancelText: isZh ? '保留' : 'Keep', tone: 'danger' })) return;
      const result = type === 'cleanup' ? await registry.api.cleanup({ ...scope, requestIds: [id] }) : type === 'archive' ? await registry.api.archive({ ...scope, requestId: id }) : await registry.api.clearDelivery({ ...scope, id });
      if (!result.ok) { setError(resourceEditMessage(result.code, isZh)); return; }
      setSelected(null); await Promise.all([index.reload(), historyOpen ? history.reload() : Promise.resolve()]);
    } catch { setError(resourceEditMessage('RESOURCE_EDIT_SOURCE_UNAVAILABLE', isZh)); }
    finally { setPending(false); }
  };
  return <section className="resource-edit-library" aria-label={isZh ? '本机草稿与修改历史' : 'Local drafts and edit history'}>
    <header className="resource-library-heading">
      <h2>{isZh ? '文档草稿' : 'Document drafts'}</h2>
      <button type="button" className="ui-button resource-library-refresh" disabled={index.loading} aria-busy={index.loading}
        aria-label={isZh ? '刷新草稿' : 'Refresh drafts'} title={isZh ? '刷新草稿' : 'Refresh drafts'} onClick={() => void index.reload()}><PeerIcon name="repeat" size={16} /></button>
    </header>
    {drafts.length ? <ul>{drafts.map(draft => <li key={draft.id}>
      <button type="button" className="resource-tool resource-library-open" onClick={() => onOpen(draft)}>
        <PeerIcon name="fileText" size={18} /><span className="resource-library-file">
          <span className="resource-library-file-name">{fileLabel(draft.target.reference.path)}</span>
          <span className="resource-library-path">{draft.target.reference.path}</span>
          <span className="resource-library-meta">{draft.hasChanges ? (isZh ? '本机保存的稿件' : 'Locally saved draft text') : (isZh ? '本机草稿' : 'Local draft')} · {new Date(draft.updatedAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}</span>
        </span><PeerIcon name="chevronRight" size={14} />
      </button></li>)}</ul>
      : index.value?.ok && !local.length && !index.loading ? <p className="resource-library-empty">{isZh ? '暂无文档草稿' : 'No document drafts yet'}</p> : null}
    {local.map(({ session }) => {
      const state = session.snapshot(), path = state.view?.draft.target.reference.path ?? state.baseline?.target.reference.path;
      return <p key={session.draftId} className="resource-library-notice" title={path}>{isZh ? '尚未确认保存，输入已保留' : 'Save unconfirmed; input preserved'}{path ? ` · ${fileLabel(path)}` : ''}</p>;
    })}
    {index.loading ? <p className="resource-library-empty" role="status">{isZh ? '正在读取草稿…' : 'Loading drafts…'}</p> : null}
    {index.error || index.value && !index.value.ok ? <p role="alert">{resourceEditMessage(index.value && !index.value.ok ? index.value.code : 'RESOURCE_EDIT_SOURCE_UNAVAILABLE', isZh)}</p> : null}
    {index.value?.ok && index.value.staleCount > 0 ? <p className="resource-source-label">{isZh ? '原会话的草稿记录仍保留，未迁移到当前会话。' : 'Drafts for a previous conversation are preserved and have not moved to this conversation.'}</p> : null}
    <details className="resource-library-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
      <summary><span className="resource-library-history-label"><PeerIcon name="history" size={18} /><span>{isZh ? '修改历史' : 'Edit history'}</span></span><PeerIcon name="chevronRight" size={14} /></summary>
      <div className="resource-library-history-body">
      <h3>{isZh ? '修改记录' : 'Edit records'}</h3>
      {operations.length ? <ul>{operations.map(operation => <li key={operation.requestId}><span className="resource-library-file-name">{fileLabel(operation.target.reference.path)}</span><span className="resource-library-path">{operation.target.reference.path}</span><p className="resource-source-label">{operation.phase === 'settled' ? resourceEditOutcome(operation.receipt?.outcome, isZh) : operation.phase === 'uncertain' ? (isZh ? '结果待核对，不会自动重跑' : 'Result needs reconciliation; no automatic replay') : operation.phase === 'running' ? (isZh ? '执行中' : 'Running') : (isZh ? '已记录意图，尚未执行' : 'Intent recorded; not executed')}</p>
        <details><summary><PeerIcon name="chevronRight" size={12} />{isZh ? '原始关联' : 'Original association'}</summary><code>{operation.requestId}</code>{operation.receipt ? <pre>{JSON.stringify(operation.receipt, null, 2)}</pre> : null}</details>
        {operation.phase === 'settled' ? <div className="resource-library-actions"><button className="ui-button is-compact" disabled={pending} onClick={() => void mutate('cleanup', operation.requestId)}>{isZh ? '清理历史正文' : 'Clear historical text'}</button><button className="ui-button is-compact" disabled={pending} onClick={() => void mutate('archive', operation.requestId)}>{isZh ? '归档记录' : 'Archive record'}</button></div> : null}</li>)}</ul> : index.value?.ok && !index.loading ? <p className="resource-library-empty">{isZh ? '暂无修改记录' : 'No edit records yet'}</p> : null}
      {previous.length || moreRecords ? <div className="resource-library-actions"><button className="ui-button is-compact" disabled={!previous.length || index.loading} onClick={() => { setCursor(previous.at(-1)); setPrevious(values => values.slice(0, -1)); }}>{isZh ? '上一页记录' : 'Previous records'}</button>
        <button className="ui-button is-compact" disabled={!moreRecords || index.loading} onClick={() => { if (!index.value?.ok || !index.value.nextCursor) return; setPrevious(values => [...values, cursor]); setCursor(index.value.nextCursor); }}>{isZh ? '下一页记录' : 'Next records'}</button></div> : null}
      <h3>{isZh ? '保存的版本' : 'Saved versions'}</h3>
      {items.length ? <ul>{items.map(item => <li key={item.id}><button className="resource-tool resource-library-open" disabled={item.availability !== 'retained'} onClick={() => setSelected(item)}>
        <PeerIcon name="fileText" size={18} /><span className="resource-library-file"><span className="resource-library-file-name">{fileLabel(item.target.reference.path)}</span><span className="resource-library-path">{item.target.reference.path}</span><span className="resource-library-meta">{item.purpose === 'before' ? (isZh ? '修改前' : 'Before') : item.purpose === 'after' ? (isZh ? '修改后' : 'After') : (isZh ? '固定交付' : 'Fixed delivery')} · {item.availability === 'retained' ? (isZh ? '查看保存的版本' : 'Read saved version') : (isZh ? '正文已清理' : 'Text cleared')}</span></span><PeerIcon name="chevronRight" size={14} /></button>
        <details><summary><PeerIcon name="chevronRight" size={12} />{isZh ? '来源依据' : 'Source evidence'}</summary><code>{item.evidenceRef}</code></details>
        {item.purpose === 'delivery' && item.availability === 'retained' ? <button className="ui-button is-compact" disabled={pending} onClick={() => void mutate('delivery', item.id)}>{isZh ? '清理交付正文' : 'Clear delivery text'}</button> : null}</li>)}</ul> : history.value?.ok && !history.loading ? <p className="resource-library-empty">{isZh ? '暂无保存的版本' : 'No saved versions yet'}</p> : null}
      {history.loading ? <p className="resource-library-empty" role="status">{isZh ? '正在读取历史…' : 'Reading history…'}</p> : null}
      {history.error || history.value && !history.value.ok ? <p role="alert">{resourceEditMessage(history.value && !history.value.ok ? history.value.code : 'RESOURCE_EDIT_SOURCE_UNAVAILABLE', isZh)}</p> : null}
      {history.value?.ok && history.value.unavailableCount > 0 ? <p className="resource-source-label">{isZh ? '有些历史来源当前不可访问，未扩大访问范围。' : 'Some historical sources are unavailable within the current access scope.'}</p> : null}
      {historyPrevious.length || moreSnapshots ? <div className="resource-library-actions"><button className="ui-button is-compact" disabled={!historyPrevious.length || history.loading} onClick={() => { setHistoryCursor(historyPrevious.at(-1)); setHistoryPrevious(values => values.slice(0, -1)); }}>{isZh ? '上一页正文' : 'Previous snapshots'}</button>
        <button className="ui-button is-compact" disabled={!moreSnapshots || history.loading} onClick={() => { if (!history.value?.ok || !history.value.nextCursor) return; setHistoryPrevious(values => [...values, historyCursor]); setHistoryCursor(history.value.nextCursor); }}>{isZh ? '下一页正文' : 'Next snapshots'}</button></div> : null}
      {selected ? <section className="resource-library-snapshot"><h3>{isZh ? '保存的版本 · 只读' : 'Saved version · Read only'}</h3><p className="resource-source-label">{selected.target.reference.path}</p>
        {content.value?.ok ? <SourceViewer content={content.value.content} language={highlightLanguageForPath(selected.target.reference.path)} isZh={isZh} emptyLabel={isZh ? '此版本为空。' : 'Empty version.'} /> : <p role="status">{content.loading ? (isZh ? '正在读取留存正文…' : 'Reading retained text…') : (isZh ? '留存正文已清理或当前不可访问，未用当前文件替代。' : 'Retained text is cleared or unavailable. The current file was not substituted.')}</p>}
        <button className="ui-button is-compact" onClick={() => setSelected(null)}>{isZh ? '收起版本预览' : 'Close version preview'}</button></section> : null}
      </div>
    </details>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
