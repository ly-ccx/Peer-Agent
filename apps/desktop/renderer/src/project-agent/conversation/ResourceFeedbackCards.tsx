import { useResourceWorkspace } from '../../workbench/ResourceWorkspaceContext';
import type { ResourceFeedback } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
export function ResourceFeedbackCards({ rows, botName, conversationId, isZh, onRemove, sent = false }: {
  readonly rows: readonly ResourceFeedback[]; readonly botName: string; readonly conversationId?: string; readonly isZh: boolean; readonly onRemove?: (id: string) => void; readonly sent?: boolean;
}) {
  const workspace = useResourceWorkspace();
  if (!rows.length) return null;
  const open = (row: ResourceFeedback) => {
    const resource = row.resource;
    if (!workspace?.ready) return;
    if (resource.kind === 'web') workspace.openUrl(resource.url);
    else if (resource.kind === 'comparison') workspace.openComparison(resource.reference, { fromRef: resource.fromRef, ...(resource.toRef ? { toRef: resource.toRef } : {}), ...(resource.comparison ? { comparison: resource.comparison } : {}) });
    else workspace.openReference({ ...resource.reference, ...(row.version.kind === 'content' ? { expectedObservation: { resourceId: row.version.resourceId, contentVersion: row.version.contentVersion } } : {}) });
  };
  return <div className="bot-resource-feedback-cards" aria-label={sent ? (isZh ? '资源引用' : 'Resource references') : (isZh ? '待发送的资源引用' : 'Resource references to send')}>{rows.map(row => {
    const path = row.resource.kind === 'web' ? row.resource.url : row.resource.reference.path;
    const label = row.resource.kind === 'web' ? path : path.split(/[\\/]/).pop() || path;
    const version = row.version.kind === 'content' ? row.version.contentVersion.slice(7, 19) : row.version.kind === 'git' ? row.version.commit.slice(0, 12)
      : row.version.kind === 'web-document' ? (isZh ? '网页摘录，非页面快照' : 'Page excerpt, not a page snapshot') : row.version.digest.slice(7, 19);
    const stale = !!conversationId && row.recipient.conversationId !== conversationId;
    return <section className="bot-resource-feedback-card" key={row.id}>
      <header><PeerIcon name={row.resource.kind === 'web' ? 'globe' : row.resource.kind === 'directory' ? 'folder' : 'fileText'} size={14} />
        <button className="resource-feedback-source" type="button" title={row.resource.kind === 'document' && row.resource.mode === 'diff' ? `${path} · ${isZh ? '打开当前文件；摘录保留原比较版本' : 'Open current file; the excerpt retains its captured comparison version'}` : path} disabled={!workspace?.ready} onClick={() => open(row)}>{label}</button><span title={row.recipient.conversationId}>{sent ? (isZh ? '随此消息发送的引用' : 'Reference sent with this message') : (isZh ? `发送给 ${botName}` : `To ${botName}`)}</span>
        <>{onRemove ? <button type="button" className="ui-button is-icon" aria-label={isZh ? '移除此资源引用' : 'Remove this resource reference'} onClick={() => onRemove(row.id)}><PeerIcon name="close" size={14} /></button> : null}</></header>
      <p title={JSON.stringify(row.version)}>{row.selection.kind === 'source' ? (isZh ? `源码 ${row.selection.range.startLine}:${row.selection.range.startColumn}—${row.selection.range.endLine}:${row.selection.range.endColumn}` : `Source ${row.selection.range.startLine}:${row.selection.range.startColumn}—${row.selection.range.endLine}:${row.selection.range.endColumn}`) : (isZh ? '讨论引用' : 'Discussion reference')} · {version}</p>
      {row.resource.kind === 'web' && row.resource.pageUrl ? <p title={row.resource.pageUrl}>{isZh ? '所在页面：' : 'Containing page: '}{row.resource.pageUrl}</p> : null}
      <blockquote>{row.excerpt}</blockquote>
      {stale ? <p role="alert">{isZh ? '原收件会话已变化；请移除此引用后重新选择。' : 'The original recipient conversation changed. Remove this reference and select it again.'}</p> : null}
    </section>;
  })}</div>;
}
