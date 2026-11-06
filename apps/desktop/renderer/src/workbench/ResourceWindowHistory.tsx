import { useEffect, useRef, useState } from 'react';
import type { ResourceWindowHistoryEntry } from '@peer-agent/protocol';
import { PeerIcon } from '../ui/icons';

/** Explicit recovery only: listing old reading metadata never opens or executes a resource. */
export function ResourceWindowHistory({ workspaceId, isZh, active }: { readonly workspaceId: string; readonly isZh: boolean; readonly active: boolean }) {
  const [entries, setEntries] = useState<readonly ResourceWindowHistoryEntry[]>([]), [failure, setFailure] = useState('');
  const [busy, setBusy] = useState<string | null>(null), [retry, setRetry] = useState(0);
  const live = useRef(false), api = window.peerAgent;
  useEffect(() => {
    live.current = true;
    if (!active || !api?.resourceWindowHistory) return () => { live.current = false; };
    let current = true;
    void api.resourceWindowHistory({ workspaceId }).then(result => {
      if (!current) return;
      if (result.ok) { setEntries(result.entries); setFailure(''); }
      else setFailure(isZh ? '暂时无法读取独立窗口的阅读记录。' : 'Unable to read saved window positions.');
    }).catch(() => { if (current) setFailure(isZh ? '暂时无法读取阅读记录，可重试。' : 'Unable to read saved positions. Retry.'); });
    return () => { current = false; live.current = false; };
  }, [workspaceId, active, api, retry, isZh]);
  if (!api?.resourceWindowHistory || !api.resourceWindowRestore || !api.resourceWindowForget || !active || !entries.length && !failure) return null;
  const restore = async (id: string) => {
    setBusy(id); setFailure('');
    try {
      const result = await api.resourceWindowRestore!({ workspaceId, id });
      if (live.current && !result.ok) setFailure(result.status === 'content_cleaned'
        ? (isZh ? '结果正文已清理，无法恢复历史计算。阅读记录仍保留。' : 'The result content was cleaned. Historical calculations cannot be restored; the reading record is retained.')
        : result.status === 'incompatible_result' ? (isZh ? '当前版本无法安全读取结果格式，原记录未改动。' : 'This version cannot safely read the result format. The original record is unchanged.')
        : result.status === 'result_unavailable' ? (isZh ? '此设备没有这份固定版本的结果，原阅读记录仍保留。' : 'This device does not have the fixed result version. The original reading record is retained.')
        : result.status === 'source_changed'
        ? (isZh ? '原来源已变化。记录已保留，请从原会话重新确认位置。' : 'The original source changed. The record is retained. Confirm its location in the source conversation.')
        : result.status === 'permission_denied' || result.status === 'scope_denied' ? (isZh ? '当前没有读取原位置的权限。记录已保留，未扩大访问范围。' : 'Reading the original location is not permitted. The record is retained; access was not expanded.')
          : result.status === 'not_found' ? (isZh ? '原文件或目录不存在，记录已保留，未打开同名替代项。' : 'The original file or directory is missing. The record is retained; no same-name replacement was opened.')
        : result.status === 'storage_unavailable' ? (isZh ? '阅读记录暂不可用或来自较新版本，未覆盖原记录。' : 'The reading record is unavailable or belongs to a newer version. It was not overwritten.')
        : result.status === 'limit_reached' ? (isZh ? '资源窗口已达上限，请先关闭一个。' : 'Resource window limit reached. Close one first.')
          : (isZh ? '原 Bot、任务或文件当前不可用。记录保留，未替换来源。' : 'The original Bot, task or file is unavailable. The record is retained; no source was substituted.'));
    } catch { if (live.current) setFailure(isZh ? '暂时无法恢复阅读，可重试。' : 'Unable to restore this reading. Retry.'); }
    finally { if (live.current) setBusy(null); }
  };
  const forget = async (id: string) => {
    setBusy(id);
    try { const result = await api.resourceWindowForget!({ workspaceId, id });
      if (live.current) { if (result.ok) setEntries(current => current.filter(entry => entry.id !== id)); else setFailure(isZh ? '未能移除记录，原文件未改动。' : 'Unable to remove the record. The file is unchanged.'); }
    } catch { if (live.current) setFailure(isZh ? '未能移除记录，可重试。' : 'Unable to remove the record. Retry.'); }
    finally { if (live.current) setBusy(null); }
  };
  return <section className="resource-window-history" aria-label={isZh ? '独立窗口阅读记录' : 'Saved window readings'}>
    <h2>{isZh ? '独立窗口阅读记录' : 'Saved window readings'}</h2>
    {failure ? <p role="alert">{failure}<button className="ui-button is-compact" type="button" onClick={() => setRetry(value => value + 1)}>{isZh ? '重新读取' : 'Read again'}</button></p> : null}
    {entries.map(entry => {
      const resource = entry.request.resource;
      const label = resource.kind === 'interactive' ? entry.title || (isZh ? '交互结果' : 'Interactive result') : resource.reference.path.split(/[\\/]/).pop() || resource.reference.path;
      return <div className="resource-window-history-row" key={entry.id}>
      <button className="resource-recent" type="button" disabled={busy !== null} title={resource.kind === 'interactive' ? label : resource.reference.path} onClick={() => void restore(entry.id)}>
        <PeerIcon name={entry.request.resource.kind === 'directory' ? 'folder' : 'fileText'} size={16} />
        <span>{label}</span>
        <small>{isZh ? '继续只读查看' : 'Continue reading'}</small>
      </button>
      <button className="ui-button resource-search-submit" type="button" disabled={busy !== null} aria-label={isZh ? '移除阅读记录' : 'Remove reading record'} title={resource.kind === 'interactive' ? (isZh ? '仅移除阅读记录，保留结果' : 'Remove the reading record and keep the result') : (isZh ? '仅移除记录，保留原文件' : 'Remove the record and keep the file')} onClick={() => void forget(entry.id)}><PeerIcon name="close" size={14} /></button>
    </div>; })}
  </section>;
}
